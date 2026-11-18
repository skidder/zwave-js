import { ControllerStatus } from "@zwave-js/core";
import { describe, expect, it } from "vitest";

import {
	REPORT_FLOOD_WARMUP_MS,
	ReportFloodMonitor,
	clusterPowerLevels,
	computeSuggestionRows,
	intervalValueToMs,
	isDisabledInterval,
	msToIntervalUnit,
	smallestLevelStep,
	smallestParamStep,
	type MaintenanceFinding,
	type MaintenanceFindingEvent,
	type ReportingParam,
} from "./ReportFloodMonitor.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A param like ZEN04 #5: power threshold in W, 5..100 */
function powerThresholdParam(
	overrides: Partial<ReportingParam> = {},
): ReportingParam {
	return {
		parameter: 5,
		purpose: "reporting_threshold.power",
		unit: "W",
		minValue: 5,
		maxValue: 100,
		defaultValue: 5,
		options: [],
		...overrides,
	};
}

/** A param like ZEN04 #6: power interval in minutes, 1..360 */
function powerIntervalParam(
	overrides: Partial<ReportingParam> = {},
): ReportingParam {
	return {
		parameter: 6,
		purpose: "reporting_interval.power",
		unit: "minutes",
		minValue: 1,
		maxValue: 360,
		defaultValue: 5,
		options: [],
		...overrides,
	};
}

function createMonitor(
	clock: () => number,
	getReportingParams?: (nodeId: number) => Promise<ReportingParam[]>,
	getNodeValue?: (nodeId: number, parameter: number) => number | undefined,
	events?: MaintenanceFindingEvent[],
) {
	return new ReportFloodMonitor({
		now: clock,
		getReportingParams,
		getNodeValue,
		onFindingEvent: (event, finding) => events?.push(event),
	});
}

/** Records `frames` frames for a node, spread evenly over the window ending at `end` */
function recordFrames(
	monitor: ReportFloodMonitor,
	nodeId: number,
	frames: number,
	windowMs: number,
	end: number,
): void {
	if (frames === 0) return;
	const step = windowMs / frames;
	for (let i = 0; i < frames; i++) {
		monitor.recordRX(nodeId, end - windowMs + Math.floor(step * i));
	}
}

describe("report flood monitor / buckets", () => {
	it("warms up: no findings in the first 60 minutes", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// A loud node: 400 frames/h, 10% of network inbound
		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);
		await monitor.evaluate();
		expect(monitor.getFindings().length).toBe(0);

		// 60 minutes after the driver start, the finding appears
		now += REPORT_FLOOD_WARMUP_MS + MIN;
		for (let h = 1; h <= 3; h++) {
			recordFrames(monitor, 2, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 3, 2000, HOUR, now - h * HOUR);
		}
		// Plus loud nodes right now
		recordFrames(monitor, 2, 2000, HOUR, now);
		recordFrames(monitor, 3, 2000, HOUR, now);
		await monitor.evaluate();
		expect(monitor.getFindings().length).toBeGreaterThan(0);
	});

	it("decays: frames older than 24 h do not count", () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// 400 frames 25 hours ago - outside the retention window
		recordFrames(monitor, 2, 400, HOUR, now - 25 * HOUR);
		// 200 frames in the last hour
		recordFrames(monitor, 2, 200, HOUR, now);
		expect(monitor.nodeRate60Min(2, now)).toBe(200);
	});

	it("keeps only the last 256 power values per node", () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;
		// Make the node loud enough for power tracking (>= 180/h)
		recordFrames(monitor, 2, 400, HOUR, now);
		for (let i = 0; i < 300; i++) {
			monitor.recordPowerValue(2, 50 + i, now + i);
		}
		// 300 were recorded, only 256 may be kept
		const record = (monitor as any)._nodeRecords.get(2);
		expect(record.powerSamples.length).toBe(256);
		// The first 44 samples were dropped
		expect(record.powerSamples[0].value).toBe(50 + 44);
	});
});

describe("report flood monitor / loud node rule", () => {
	it("names nodes above 360/h with >= 10% share", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);
		expect(monitor.isLoudNode(2, now)).toBe(true);
		expect(monitor.isLoudNode(3, now)).toBe(true);

		// A node below the 10% share is not loud
		recordFrames(monitor, 4, 400, HOUR, now);
		recordFrames(monitor, 5, 10000, HOUR, now);
		expect(monitor.isLoudNode(4, now)).toBe(false);
		expect(monitor.isLoudNode(5, now)).toBe(true);
	});

	it("excludes buckets that overlap a jam, plus 2 minutes", () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Use a bucket-aligned clock so the bucket contents are predictable
		now = 4 * HOUR;

		// 400 frames in the last 60 minutes (buckets 12-15)
		recordFrames(monitor, 2, 400, HOUR, now);
		expect(monitor.nodeRate60Min(2, now)).toBe(400);

		// ...but the controller was jammed from t=210min to t=235min:
		// the buckets overlapping the jam + 2 min padding are excluded,
		// which removes the frames from t=210min onwards
		monitor.recordControllerStatus(ControllerStatus.Jammed, now - 30 * MIN);
		monitor.recordControllerStatus(ControllerStatus.Ready, now - 5 * MIN);
		expect(monitor.nodeRate60Min(2, now)).toBeLessThan(360);
		expect(monitor.isLoudNode(2, now)).toBe(false);

		// Frames outside the jam + padding still count:
		// 400 more frames in [t=180min, t=210min], before the jam
		recordFrames(monitor, 2, 400, 30 * MIN, now - 30 * MIN);
		expect(monitor.nodeRate60Min(2, now)).toBeGreaterThanOrEqual(400);
		expect(monitor.isLoudNode(2, now)).toBe(true);
	});
});

describe("report flood monitor / network rules", () => {
	it("raises a warning when >= 3 of the trailing 24 hours had >= 1000 frames/h", async () => {
		let now = 0;
		const clock = () => now;
		const events: MaintenanceFindingEvent[] = [];
		const monitor = createMonitor(clock, undefined, undefined, events);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// 3 hours with 2000 frames/h, 20 hours ago and earlier
		for (let h = 4; h <= 6; h++) {
			recordFrames(monitor, 2, 2000, HOUR, now - h * HOUR);
		}
		// A loud node right now
		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);

		await monitor.evaluate();
		const warning = monitor
			.getFindings()
			.find((f) => f.kind === "loud-network");
		expect(warning).toBeDefined();
		expect(warning!.severity).toBe("warning");
		expect(
			warning!.nodes.map((n) => n.nodeId).toSorted((a, b) => a - b),
		).toEqual([2, 3]);
		expect(events).toContain("maintenance finding");
	});

	it("does not raise the warning with fewer than 3 loud hours", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// Only 2 hours above 1000/h; the current hour stays below it
		for (let h = 4; h <= 5; h++) {
			recordFrames(monitor, 2, 2000, HOUR, now - h * HOUR);
		}
		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 500, HOUR, now);

		await monitor.evaluate();
		expect(
			monitor.getFindings().find((f) => f.kind === "loud-network"),
		).toBeUndefined();
	});

	it("raises an error when a single jam episode lasted >= 5 min and a node is loud", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);
		monitor.recordControllerStatus(ControllerStatus.Jammed, now - 6 * MIN);
		monitor.recordControllerStatus(ControllerStatus.Ready, now - MIN);

		await monitor.evaluate();
		const error = monitor.getFindings().find((f) => f.kind === "jammed");
		expect(error).toBeDefined();
		expect(error!.severity).toBe("error");
	});

	it("raises an error after 60 jammed transmit attempts in 24 h", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);
		for (let i = 0; i < 60; i++) {
			monitor.recordJammedTransmitAttempt(now - 10 * MIN - i * 1000);
		}

		await monitor.evaluate();
		expect(
			monitor.getFindings().find((f) => f.kind === "jammed"),
		).toBeDefined();
	});

	it("raises an error when jam time exceeds 1% of 24 h", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		recordFrames(monitor, 2, 400, HOUR, now);
		recordFrames(monitor, 3, 3600, HOUR, now);
		// 15 minutes of jam: more than 1% of 24 h (14.4 min)
		monitor.recordControllerStatus(ControllerStatus.Jammed, now - 15 * MIN);
		monitor.recordControllerStatus(ControllerStatus.Ready, now - MIN);

		await monitor.evaluate();
		expect(
			monitor.getFindings().find((f) => f.kind === "jammed"),
		).toBeDefined();
	});

	it("a jam without a loud node is not this finding", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// Quiet network, long jam
		monitor.recordControllerStatus(ControllerStatus.Jammed, now - 30 * MIN);
		monitor.recordControllerStatus(ControllerStatus.Ready, now - MIN);

		await monitor.evaluate();
		expect(monitor.getFindings().length).toBe(0);
	});

	it("stays silent on a quiet network (R2: 90 frames/h)", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(clock);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// 90 frames/h for the last 24 hours, spread over a few nodes
		for (let h = 0; h <= 23; h++) {
			recordFrames(monitor, 2, 42, HOUR, now - h * HOUR);
			recordFrames(monitor, 3, 48, HOUR, now - h * HOUR);
		}
		await monitor.evaluate();
		expect(monitor.getFindings().length).toBe(0);
		expect(monitor.loudNodes(now)).toEqual([]);
	});

	it("resolves a finding when traffic quiets down", async () => {
		let now = 0;
		const clock = () => now;
		const events: Array<[MaintenanceFindingEvent, MaintenanceFinding]> = [];
		const monitor = new ReportFloodMonitor({
			now: clock,
			onFindingEvent: (event, finding) => events.push([event, finding]),
		});
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// 3 loud hours so the warning rule fires
		for (let h = 1; h <= 3; h++) {
			recordFrames(monitor, 2, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 3, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 4, 2000, HOUR, now - h * HOUR);
		}
		// Plus loud nodes right now
		recordFrames(monitor, 2, 2000, HOUR, now);
		recordFrames(monitor, 3, 2000, HOUR, now);
		recordFrames(monitor, 4, 2000, HOUR, now);
		await monitor.evaluate();
		expect(monitor.getFindings().length).toBe(1);

		// Traffic drops to near zero
		now = now + 25 * HOUR;
		recordFrames(monitor, 2, 10, HOUR, now);
		await monitor.evaluate();
		expect(monitor.getFindings().length).toBe(0);
		expect(events.some(([e]) => e === "maintenance finding resolved")).toBe(
			true,
		);
	});
});

describe("report flood monitor / unit conversion", () => {
	it("converts interval units to ms and back", () => {
		expect(msToIntervalUnit(900_000, "seconds")).toBe(900);
		expect(msToIntervalUnit(900_000, "min")).toBe(15);
		expect(msToIntervalUnit(900_000, "minutes")).toBe(15);
		expect(msToIntervalUnit(900_000, "5 seconds")).toBe(180);
		expect(msToIntervalUnit(900_000, "10 minutes")).toBe(1.5);

		expect(intervalValueToMs(300, "seconds")).toBe(300_000);
		expect(intervalValueToMs(15, "Min")).toBe(900_000);
		expect(intervalValueToMs(300, "s")).toBe(300_000);

		// Unknown units are not converted
		expect(msToIntervalUnit(900_000, "hours")).toBeUndefined();
		expect(intervalValueToMs(15, "banana")).toBeUndefined();
	});

	it("normalizes case and spaces", () => {
		expect(msToIntervalUnit(900_000, "  MINUTES ")).toBe(15);
		expect(intervalValueToMs(5, "5 Seconds")).toBe(25_000);
	});
});

describe("report flood monitor / suggestion math", () => {
	it("computes T_jitter as 3x P95 of |delta|, rounded up to 5 W", () => {
		// Deltas between consecutive power reports: 1..10 W
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 10; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam()],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows.length).toBe(1);
		// P95 of deltas [1..10] is 10, 3x = 30, already a multiple of 5
		expect(rows[0].proposedValue).toBe(30);
	});

	it("rounds T_jitter up to the next 5 W", () => {
		// Deltas: 1..8 -> P95 = 8, 3x = 24 -> 25
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 8; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam()],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows[0].proposedValue).toBe(25);
	});

	it("caps T at the param max", () => {
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 10; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam({ maxValue: 20 })],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows[0].proposedValue).toBe(20);
	});

	it("caps T at 0.5x the smallest real step", () => {
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 10; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const param = powerThresholdParam({
			allowed: [{ from: 5, to: 100, step: 20 }],
		});
		expect(smallestParamStep(param)).toBe(20);
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [param],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		// T_jitter = 30, 0.5 x 20 = 10 -> capped at 10
		expect(rows[0].proposedValue).toBe(10);
	});

	it("uses recommendedValue instead of T_jitter", () => {
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 10; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam({ recommendedValue: 12 })],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows[0].proposedValue).toBe(12);
	});

	it("computes the percent variant as 3x P95 of |delta|/level, rounded up to 5%", () => {
		// A ~100 W load jittering by +-5 W: |delta|/level ~ 10/105 ~ 9.5%
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i <= 20; i++) {
			samples.push({
				timestamp: i * MIN,
				value: 100 + (i % 2 === 0 ? 5 : -5),
			});
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [
					powerThresholdParam({
						parameter: 152,
						purpose: "reporting_threshold.power",
						unit: "%",
						minValue: 1,
						maxValue: 50,
						defaultValue: 10,
					}),
				],
				currentValues: new Map([[152, 10]]),
			},
			samples.at(-1)!.timestamp,
		);
		// 3 x 10% = 30%
		expect(rows[0].proposedValue).toBe(30);
	});

	it("only raises, never lowers: no row when the proposed value is <= current", () => {
		const samples: { timestamp: number; value: number }[] = [];
		let value = 100;
		for (let i = 0; i <= 10; i++) {
			samples.push({ timestamp: i * MIN, value });
			value += (i % 2 === 0 ? 1 : -1) * (i + 1);
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam()],
				currentValues: new Map([[5, 50]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows.length).toBe(0);
	});

	it("writes power intervals up to 15 min, clamped to min/max", () => {
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [powerIntervalParam({ minValue: 10, maxValue: 360 })],
				currentValues: new Map([[6, 5]]),
			},
			0,
		);
		expect(rows.length).toBe(1);
		expect(rows[0].proposedValue).toBe(15);

		// Clamped to the max
		const clamped = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [powerIntervalParam({ maxValue: 10 })],
				currentValues: new Map([[6, 5]]),
			},
			0,
		);
		expect(clamped[0].proposedValue).toBe(10);
	});

	it("writes energy/current/voltage intervals up to 60 min", () => {
		for (const scale of ["energy", "current", "voltage"]) {
			const rows = computeSuggestionRows(
				{
					floodScales: [scale],
					powerSamples: [],
					params: [
						powerIntervalParam({
							purpose: `reporting_interval.${scale}`,
						}),
					],
					currentValues: new Map([[6, 5]]),
				},
				0,
			);
			expect(rows.length).toBe(1);
			expect(rows[0].proposedValue).toBe(60);
		}
	});

	it("never enables a disabled interval", () => {
		const param = powerIntervalParam({
			options: [
				{ value: 0, label: "Disabled" },
				{
					value: 60,
					label: "60 minutes",
				},
			],
			minValue: 0,
		});
		// Disabled at value 0: no row, even though 0 < target
		expect(isDisabledInterval(param, 0)).toBe(true);
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [param],
				currentValues: new Map([[6, 0]]),
			},
			0,
		);
		expect(rows.length).toBe(0);

		// Not disabled at a nonzero value
		expect(isDisabledInterval(param, 5)).toBe(false);
	});

	it("converts interval units per param, e.g. ZEN15 seconds", () => {
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [
					powerIntervalParam({
						parameter: 171,
						unit: "seconds",
						minValue: 5,
						maxValue: 3600,
						defaultValue: 300,
					}),
				],
				currentValues: new Map([[171, 300]]),
			},
			0,
		);
		expect(rows.length).toBe(1);
		expect(rows[0].proposedValue).toBe(900);
	});

	it("skips interval rows that are already at or above the target", () => {
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [powerIntervalParam()],
				currentValues: new Map([[6, 30]]),
			},
			0,
		);
		expect(rows.length).toBe(0);
	});

	it("offers no threshold rows for scales it cannot compute", () => {
		// Energy threshold with no recommendedValue: no number
		const rows = computeSuggestionRows(
			{
				floodScales: ["energy"],
				powerSamples: [],
				params: [
					powerThresholdParam({
						purpose: "reporting_threshold.energy",
						unit: "kWh",
					}),
				],
				currentValues: new Map([[5, 1]]),
			},
			0,
		);
		expect(rows.length).toBe(0);

		// ...but with a recommendedValue it is offered
		const withRecommended = computeSuggestionRows(
			{
				floodScales: ["energy"],
				powerSamples: [],
				params: [
					powerThresholdParam({
						purpose: "reporting_threshold.energy",
						unit: "kWh",
						recommendedValue: 5,
					}),
				],
				currentValues: new Map([[5, 1]]),
			},
			0,
		);
		expect(withRecommended.length).toBe(1);
		expect(withRecommended[0].proposedValue).toBe(5);
	});

	it("marks rows whose current value is unknown as needsGet", () => {
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: [],
				params: [powerIntervalParam()],
				currentValues: new Map([[6, undefined]]),
			},
			0,
		);
		expect(rows[0].needsGet).toBe(true);
		expect(rows[0].currentValue).toBeUndefined();
	});
});

describe("report flood monitor / real-load levels", () => {
	it("clusters stepping loads into levels", () => {
		// A 190 <-> 280 W load toggling every few minutes
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i < 60; i++) {
			const value = i % 2 === 0 ? 190 : 280;
			samples.push({ timestamp: i * 2 * MIN, value });
		}
		const levels = clusterPowerLevels(samples);
		expect(levels.length).toBe(2);
		expect(levels[0].lower).toBe(190);
		expect(levels[1].lower).toBe(280);
		expect(smallestLevelStep(levels)).toBe(90);
	});

	it("does not cluster jitter into levels", () => {
		// +-10 W jitter around 100 W: gaps of 10-20 W, but the 25% rule
		// (25% of ~100 W) separates them
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i < 100; i++) {
			samples.push({
				timestamp: i * MIN,
				value: 100 + (i % 2 === 0 ? 10 : -10),
			});
		}
		expect(clusterPowerLevels(samples).length).toBe(1);
	});

	it("requires levels to hold >= 10% of samples and dwell >= 60 s", () => {
		// Two real levels, but the 250 W level is only touched briefly
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i < 90; i++) {
			samples.push({ timestamp: i * MIN, value: 190 });
		}
		samples.push({ timestamp: 90 * MIN, value: 250 });
		const levels = clusterPowerLevels(samples);
		expect(levels.length).toBe(1);
	});

	it("refuses the threshold row when T_jitter exceeds 0.5x the level step", () => {
		// 190 <-> 280 W steps with short dwells: most deltas are the ~90 W
		// load steps themselves, so T_jitter far exceeds 0.5 x 90 = 45
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i < 60; i++) {
			const base = i % 6 < 3 ? 190 : 280;
			samples.push({
				timestamp: i * 2 * MIN,
				value: base + (i % 3 === 0 ? 2 : -2),
			});
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam(), powerIntervalParam()],
				currentValues: new Map([
					[5, 5],
					[6, 5],
				]),
			},
			samples.at(-1)!.timestamp,
		);

		const thresholdRow = rows.find((r) => r.kind === "threshold");
		const intervalRow = rows.find((r) => r.kind === "interval");
		expect(thresholdRow).toBeDefined();
		expect(thresholdRow!.refusedReason).toMatch(
			/real load that switches between \d+ W and \d+ W/,
		);
		// Interval rows are still offered
		expect(intervalRow).toBeDefined();
		expect(intervalRow!.refusedReason).toBeUndefined();
	});

	it("caps T at 0.5x the level step when T_jitter is below it", () => {
		// 190 <-> 280 W steps with long dwells and +-2 W jitter:
		// P95 of the deltas is small, so T_jitter stays below 0.5 x 90 = 45
		const samples: { timestamp: number; value: number }[] = [];
		for (let i = 0; i < 120; i++) {
			const base = i % 40 < 20 ? 190 : 280;
			samples.push({
				timestamp: i * 2 * MIN,
				value: base + (i % 3 === 0 ? 2 : -2),
			});
		}
		const rows = computeSuggestionRows(
			{
				floodScales: ["power"],
				powerSamples: samples,
				params: [powerThresholdParam()],
				currentValues: new Map([[5, 5]]),
			},
			samples.at(-1)!.timestamp,
		);
		expect(rows[0].refusedReason).toBeUndefined();
		expect(rows[0].proposedValue).toBeLessThanOrEqual(45);
	});
});

describe("report flood monitor / untagged nodes", () => {
	it("produces a finding without numbers when the config has no tags", async () => {
		let now = 0;
		const clock = () => now;
		const monitor = createMonitor(
			clock,
			// No tagged params
			async () => [],
		);
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		// 3 loud hours so the warning rule fires
		for (let h = 1; h <= 3; h++) {
			recordFrames(monitor, 2, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 3, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 4, 2000, HOUR, now - h * HOUR);
		}
		// Plus loud nodes right now
		recordFrames(monitor, 2, 2000, HOUR, now);
		recordFrames(monitor, 3, 2000, HOUR, now);
		recordFrames(monitor, 4, 2000, HOUR, now);
		await monitor.evaluate();

		const finding = monitor.getFindings()[0];
		const node = finding.nodes.find((n) => n.nodeId === 2)!;
		expect(node.hasTaggedParams).toBe(false);
		expect(node.suggestionRows).toEqual([]);
		expect(node.untaggedNote).toContain(
			"config file lacks report-parameter tags",
		);
	});
});

describe("report flood monitor / verification", () => {
	interface VerificationSetup {
		monitor: ReportFloodMonitor;
		nodeId: number;
		appliedAt: number;
		setClock: (t: number) => void;
	}

	function setupVerification(
		currentConfigValue: () => number | undefined,
	): VerificationSetup {
		let now = 0;
		const clock = () => now;
		const params: ReportingParam[] = [
			powerThresholdParam(),
			powerIntervalParam(),
		];
		const monitor = new ReportFloodMonitor({
			now: clock,
			getReportingParams: async () => params,
			getNodeValue: (_nodeId, parameter) => (parameter === 5 ? 5 : 5),
		});
		monitor.start();
		// Advance the clock past the warmup phase before recording traffic
		now = REPORT_FLOOD_WARMUP_MS + MIN;

		const nodeId = 2;
		// 3 loud hours so the warning rule fires, node 2 is loud
		for (let h = 1; h <= 3; h++) {
			recordFrames(monitor, nodeId, 2000, HOUR, now - h * HOUR);
			recordFrames(monitor, 3, 2000, HOUR, now - h * HOUR);
		}
		// Plus current traffic so the node is loud right now
		recordFrames(monitor, nodeId, 2000, HOUR, now);
		recordFrames(monitor, 3, 2000, HOUR, now);
		// Enough power reports to make "power" a flooding scale (>= 10% of
		// the node's inbound), with +-3 W jitter
		for (let i = 0; i < 400; i++) {
			monitor.recordMeterScaleUpdate(nodeId, "power", now - i * 5_000);
			monitor.recordPowerValue(
				nodeId,
				100 + (i % 2 === 0 ? 3 : -3),
				now - i * 5_000,
			);
		}
		return {
			monitor,
			nodeId,
			get appliedAt() {
				return now;
			},
			setClock: (t) => {
				now = t;
			},
		};
	}

	function getConfigParamSpy(readValue: () => number | undefined) {
		let calls = 0;
		return {
			fn: async (_nodeId: number, _parameter: number) => {
				calls++;
				return readValue();
			},
			get calls() {
				return calls;
			},
		};
	}

	it("R4: a lying write ends as 'not stored', never as 'verified'", async () => {
		const setup = setupVerification(() => 5 /* old value */);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];
		expect(finding.nodes[0].suggestionRows.length).toBeGreaterThan(0);

		const writes: Array<{ parameter: number; value: number }> = [];
		await monitor.applySuggestion(
			finding.id,
			nodeId,
			async (_n, parameter, value) => {
				writes.push({ parameter, value });
				return { setOK: true };
			},
		);
		// The write "succeeds"...
		expect(writes.length).toBeGreaterThan(0);
		const appliedAt = setup.appliedAt;

		// ...but the traffic does not drop, and the device kept its old value.
		// The rate stays high: record the same flood for another 20 minutes.
		let getSpy = getConfigParamSpy(() => 5);
		const lastRow = () => finding.nodes[0].suggestionRows.at(-1)!;

		// First pass at T+16 min: retry once, back to verifying
		setup.setClock(appliedAt + 16 * MIN);
		recordFrames(monitor, nodeId, 400, 16 * MIN, appliedAt + 16 * MIN);
		await monitor.tickVerification(getSpy.fn, () => lastRow());
		let verification = finding.verification.find(
			(v) => v.nodeId === nodeId,
		)!;
		expect(verification.state).not.toBe("verified");
		expect(verification.state).not.toBe("verified (provisional)");

		// Second pass at T+32 min: still the old value -> not stored
		setup.setClock(appliedAt + 32 * MIN);
		recordFrames(monitor, nodeId, 400, 16 * MIN, appliedAt + 32 * MIN);
		getSpy = getConfigParamSpy(() => 5);
		await monitor.tickVerification(getSpy.fn, () => lastRow());
		verification = finding.verification.find((v) => v.nodeId === nodeId)!;
		expect(verification.state).toBe("not stored");
		expect(verification.message).toBe(
			"The plug said OK but kept its old setting.",
		);
		// A cache-bypassing Get was used to determine this
		expect(getSpy.calls).toBeGreaterThan(0);
	});

	it("verifies (provisional) when the traffic drops after the write", async () => {
		const setup = setupVerification(() => 5);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: true,
		}));
		const appliedAt = setup.appliedAt;

		// The traffic drops to ~10 frames in the verification window
		setup.setClock(appliedAt + 16 * MIN);
		for (let i = 0; i < 10; i++) {
			monitor.recordRX(nodeId, appliedAt + 3 * MIN + i * MIN);
		}
		const getSpy = getConfigParamSpy(() => 30);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		const verification = finding.verification.find(
			(v) => v.nodeId === nodeId,
		)!;
		expect(verification.state).toBe("verified (provisional)");
		expect(verification.message).toMatch(/dropped from \d+\/h to \d+\/h/);

		// After 24 h of low traffic: verified
		setup.setClock(appliedAt + 25 * HOUR);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		const final = finding.verification.find((v) => v.nodeId === nodeId)!;
		expect(final.state).toBe("verified");
	});

	it("regresses when the rate is back above 360/h at T+24h", async () => {
		const setup = setupVerification(() => 5);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: true,
		}));
		const appliedAt = setup.appliedAt;

		// Drop after the write -> verified (provisional)
		setup.setClock(appliedAt + 16 * MIN);
		for (let i = 0; i < 10; i++) {
			monitor.recordRX(nodeId, appliedAt + 3 * MIN + i * MIN);
		}
		const getSpy = getConfigParamSpy(() => 30);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		expect(
			finding.verification.find((v) => v.nodeId === nodeId)!.state,
		).toBe("verified (provisional)");

		// But the flood returns within 24 h
		setup.setClock(appliedAt + 25 * HOUR);
		recordFrames(monitor, nodeId, 400, HOUR, appliedAt + 25 * HOUR);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		expect(
			finding.verification.find((v) => v.nodeId === nodeId)!.state,
		).toBe("regressed");
	});

	it("rejects when the Set fails", async () => {
		const setup = setupVerification(() => 5);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: false,
		}));
		const verification = finding.verification.find(
			(v) => v.nodeId === nodeId,
		)!;
		expect(verification.state).toBe("rejected");
		expect(verification.message).toBe("The plug refused the change.");
	});

	it("is inconclusive (idle) when the load goes idle", async () => {
		const setup = setupVerification(() => 5);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: true,
		}));
		const appliedAt = setup.appliedAt;

		// No traffic at all in the window
		setup.setClock(appliedAt + 16 * MIN);
		const getSpy = getConfigParamSpy(() => 30);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		const verification = finding.verification.find(
			(v) => v.nodeId === nodeId,
		)!;
		expect(verification.state).toBe("inconclusive (idle)");
		expect(verification.message).toBe("Waiting for the load to run.");

		// It re-tests when the load comes back
		setup.setClock(appliedAt + 20 * MIN);
		monitor.recordRX(nodeId, appliedAt + 19 * MIN);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		expect(
			finding.verification.find((v) => v.nodeId === nodeId)!.state,
		).toBe("verifying");
	});

	it("verifies 'stored, no effect' when the setting took but traffic stayed high", async () => {
		// The Get returns the interval row's proposed value (15 min)
		const setup = setupVerification(() => 15 /* new value */);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: true,
		}));
		const appliedAt = setup.appliedAt;

		setup.setClock(appliedAt + 16 * MIN);
		recordFrames(monitor, nodeId, 400, 16 * MIN, appliedAt + 16 * MIN);
		const getSpy = getConfigParamSpy(() => 15);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		expect(
			finding.verification.find((v) => v.nodeId === nodeId)!.state,
		).toBe("stored, no effect");
	});

	it("verifies 'unconfirmed' when the Get has no answer", async () => {
		const setup = setupVerification(() => undefined /* no answer */);
		const { monitor, nodeId } = setup;
		await monitor.evaluate();
		const finding = monitor.getFindings()[0];

		await monitor.applySuggestion(finding.id, nodeId, async () => ({
			setOK: true,
		}));
		const appliedAt = setup.appliedAt;

		setup.setClock(appliedAt + 16 * MIN);
		recordFrames(monitor, nodeId, 400, 16 * MIN, appliedAt + 16 * MIN);
		const getSpy = getConfigParamSpy(() => undefined);
		await monitor.tickVerification(getSpy.fn, () =>
			finding.nodes[0].suggestionRows.at(-1)!,
		);
		expect(
			finding.verification.find((v) => v.nodeId === nodeId)!.state,
		).toBe("unconfirmed");
	});
});

/**
 * Detects nodes that flood the controller with excessive reports ("report flood"),
 * suggests concrete configuration changes, and verifies that the changes took effect.
 *
 * Implements the "report flood" maintenance finding:
 * - Per-node inbound traffic is tracked in 15-minute buckets (96 buckets = 24 h, in memory only).
 * - A "loud" node is one that sends at least 360 commands per trailing 60 minutes,
 *   making up at least 10% of the total inbound traffic. Buckets that overlap a
 *   Jammed/Unresponsive episode (plus 2 minutes after) are excluded, because
 *   meters re-send their reports while the controller is jammed.
 * - A warning is raised when the total inbound traffic was at least 1,000 frames/h
 *   in at least 3 hours of the trailing 24 h, and at least one node is loud.
 * - An error is raised when the controller was jammed/unresponsive for at least 1%
 *   of the trailing 24 h, or any single episode lasted at least 5 minutes, or there
 *   were at least 60 jammed transmit attempts in 24 h - and at least one node is loud.
 *
 * All user-facing strings produced here must never mention USB, firmware or the stick.
 */

import type { ConfigOption, ParamInformation } from "@zwave-js/config";
import { ControllerStatus } from "@zwave-js/core";

//region Constants

/** Size of a single traffic bucket (15 minutes) */
export const REPORT_FLOOD_BUCKET_MS = 15 * 60 * 1000;
/** Number of buckets kept per node (96 buckets = 24 h) */
export const REPORT_FLOOD_BUCKET_COUNT = 96;
/** Minimum warmup time after driver start before any finding may be raised */
export const REPORT_FLOOD_WARMUP_MS = 60 * 60 * 1000;
/** A node is loud when it sends at least this many commands per trailing 60 min */
export const REPORT_FLOOD_LOUD_NODE_RATE = 360;
/** A node is loud when it makes up at least this share of the network inbound traffic */
export const REPORT_FLOOD_NODE_SHARE = 0.1;
/** Buckets overlapping a jam are excluded, plus this padding */
export const REPORT_FLOOD_JAM_EXCLUSION_PAD_MS = 2 * 60 * 1000;
/** Network warning: inbound >= 1000 frames/h ... */
export const REPORT_FLOOD_NETWORK_RATE = 1000;
/** ... in at least this many hours of the trailing 24 h */
export const REPORT_FLOOD_NETWORK_HOURS = 3;
/** Jam error: at least 1% of the trailing 24 h */
export const REPORT_FLOOD_JAM_SHARE = 0.01;
/** Jam error: or any single episode of at least this length */
export const REPORT_FLOOD_JAM_EPISODE_MS = 5 * 60 * 1000;
/** Jam error: or at least this many jammed transmit attempts in 24 h */
export const REPORT_FLOOD_JAM_ATTEMPTS = 60;
/** Verification window start (after a suggested config change was applied) */
export const REPORT_FLOOD_VERIFY_START_MS = 2 * 60 * 1000;
/** Verification window end */
export const REPORT_FLOOD_VERIFY_END_MS = 15 * 60 * 1000;
/** Long-term verification horizon */
export const REPORT_FLOOD_VERIFY_LONG_MS = 24 * 60 * 60 * 1000;
/** Number of recent power values kept per node */
export const REPORT_FLOOD_POWER_HISTORY = 256;
/** Power values are only tracked for nodes above half the loud line */
export const REPORT_FLOOD_POWER_TRACK_RATE = REPORT_FLOOD_LOUD_NODE_RATE / 2;
/** A scale counts as flooding when it makes up at least this share of a node's inbound */
export const REPORT_FLOOD_SCALE_SHARE = 0.1;
/** Target report interval for power reports */
export const REPORT_FLOOD_POWER_INTERVAL_MS = 15 * 60 * 1000;
/** Target report interval for energy/current/voltage reports */
export const REPORT_FLOOD_OTHER_INTERVAL_MS = 60 * 60 * 1000;

//endregion

//region Public types

/** One writable suggestion for one configuration parameter */
export interface MaintenanceSuggestionRow {
	/** The configuration parameter number */
	parameter: number;
	/** The `$purpose` the parameter is tagged with, e.g. `reporting_threshold.power` */
	purpose: string;
	kind: "threshold" | "interval";
	/** Unit of the parameter value, as given in the config file */
	unit?: string;
	/** Current value, if known. `undefined` means the driver must send a Get first. */
	currentValue?: number;
	defaultValue: number;
	/** The value that should be written */
	proposedValue: number;
	minValue: number;
	maxValue: number;
	/** Whether the current value is still the factory default */
	stillAtFactoryDefault?: boolean;
	/** If set, this row must not be written, and the reason is shown to the user */
	refusedReason?: string;
	/** Whether the row needs a (single) Configuration Get before it can be applied */
	needsGet?: boolean;
}

/** Per-node part of a maintenance finding */
export interface MaintenanceNodeFinding {
	/** The node's ID */
	nodeId: number;
	/** The node's inbound rate over the trailing 60 min */
	hourlyRate: number;
	/** The node's share of the total inbound traffic, 0..1 */
	shareOfInbound: number;
	/**
	 * Whether the device config contains parameters tagged with a reporting
	 * `$purpose`. If not, the finding contains no numbers for this node.
	 */
	hasTaggedParams: boolean;
	/** Shown when the config file has no tagged reporting parameters */
	untaggedNote?: string;
	/** Suggested configuration changes for this node. */
	suggestionRows: MaintenanceSuggestionRow[];
}

export type MaintenanceFindingSeverity = "warning" | "error";

export type MaintenanceFindingKind = "loud-network" | "jammed";

export type MaintenanceVerificationState =
	| "rejected"
	| "verifying"
	| "verified (provisional)"
	| "inconclusive (idle)"
	| "not stored"
	| "stored, no effect"
	| "unconfirmed"
	| "regressed"
	| "verified";

export interface MaintenanceVerification {
	nodeId: number;
	state: MaintenanceVerificationState;
	/** Human-readable text describing the verification progress */
	message: string;
	/** Hourly rate directly before the suggested change was applied */
	preWriteRate: number;
	/** When the change was applied */
	appliedAt: number;
	/** How many retries are left after a `not stored` verdict */
	retriesLeft: number;
	/** Whether the cache-bypassing Get returned the new value */
	getResult?: "old" | "new" | "no answer";
}

export interface MaintenanceFinding {
	/** Stable identifier of this finding */
	id: string;
	kind: MaintenanceFindingKind;
	severity: MaintenanceFindingSeverity;
	/** Human-readable description of why this finding was raised */
	reason: string;
	/** The nodes that are responsible for the finding */
	nodes: MaintenanceNodeFinding[];
	/** Verification state per node, after `applyMaintenanceSuggestion` */
	verification: MaintenanceVerification[];
	createdAt: number;
	updatedAt: number;
}

export type MaintenanceFindingEvent =
	| "maintenance finding"
	| "maintenance finding updated"
	| "maintenance finding resolved";

//endregion

//region Jam episodes

interface JamEpisode {
	/** Episode start (ms timestamp) */
	start: number;
	/** Episode end (ms timestamp); open episodes have `end === start` */
	end: number;
}

//endregion

//region Unit conversion

/**
 * Normalizes a unit label: trims, lowercases, removes spaces,
 * so "0.1A", "0.1 A" and "KwH" become comparable.
 */
export function normalizeUnit(unit: string | undefined): string {
	if (!unit) return "";
	return unit.trim().toLowerCase().replaceAll(/\s+/g, "");
}

/**
 * Closed set of interval units and their multiplier to milliseconds.
 * Unknown units return `undefined`, which means "no number for this param".
 */
const INTERVAL_UNIT_MULTIPLIERS: Record<string, number> = {
	s: 1000,
	sec: 1000,
	seconds: 1000,
	second: 1000,
	min: 60_000,
	minutes: 60_000,
	minute: 60_000,
	"5seconds": 5_000,
	"10minutes": 600_000,
};

/**
 * Converts a parameter value with the given unit label to milliseconds.
 * Returns `undefined` for units outside the closed set.
 */
export function intervalValueToMs(
	value: number,
	unit: string | undefined,
): number | undefined {
	const normalized = normalizeUnit(unit);
	const multiplier = INTERVAL_UNIT_MULTIPLIERS[normalized];
	if (multiplier == undefined) return undefined;
	return value * multiplier;
}

/**
 * Converts milliseconds to a parameter value with the given unit label.
 * Returns `undefined` for units outside the closed set.
 */
export function msToIntervalUnit(
	ms: number,
	unit: string | undefined,
): number | undefined {
	const normalized = normalizeUnit(unit);
	const multiplier = INTERVAL_UNIT_MULTIPLIERS[normalized];
	if (multiplier == undefined) return undefined;
	return ms / multiplier;
}

/** Threshold units that the monitor understands, mapped to their scale */
const THRESHOLD_UNITS: Record<string, "power" | "percent"> = {
	w: "power",
	percent: "percent",
	"%": "percent",
};

/**
 * Classifies a threshold parameter unit. Returns the scale the threshold
 * applies to ("power" or "percent"), or `undefined` for unknown units.
 */
export function classifyThresholdUnit(
	unit: string | undefined,
): "power" | "percent" | undefined {
	return THRESHOLD_UNITS[normalizeUnit(unit)];
}

//endregion

//region Levels clustering

export interface PowerLevel {
	/** Lower bound of the level */
	lower: number;
	/** Upper bound of the level */
	upper: number;
	/** Number of samples in this level */
	samples: number;
	/** How long the load stayed in this level */
	dwellMs: number;
}

/**
 * Clusters power samples into levels. Samples are sorted by value; a new level
 * starts when the gap to the previous sample is at least `max(20 W, 25% of the
 * upper level)`. Only levels that hold at least 10% of the samples and were
 * dwelled in for at least 60 s are kept.
 */
export function clusterPowerLevels(
	samples: { timestamp: number; value: number }[],
): PowerLevel[] {
	if (samples.length === 0) return [];

	const byValue = samples.toSorted((a, b) => a.value - b.value);
	const total = samples.length;

	// First pass: split into groups separated by large gaps
	const groups: { timestamp: number; value: number }[][] = [];
	let currentGroup: { timestamp: number; value: number }[] = [byValue[0]];
	for (let i = 1; i < byValue.length; i++) {
		const prev = byValue[i - 1].value;
		const upper = Math.max(prev, byValue[i].value);
		const gap = byValue[i].value - prev;
		if (gap >= Math.max(20, 0.25 * upper)) {
			groups.push(currentGroup);
			currentGroup = [];
		}
		currentGroup.push(byValue[i]);
	}
	groups.push(currentGroup);

	// Second pass: compute per-level stats and filter
	const levels: PowerLevel[] = [];
	for (const group of groups) {
		const values = group.map((s) => s.value);
		const lower = Math.min(...values);
		const upper = Math.max(...values);
		const samplesInLevel = group.length;
		const dwellMs =
			Math.max(...group.map((s) => s.timestamp))
			- Math.min(...group.map((s) => s.timestamp));
		if (samplesInLevel / total >= 0.1 && dwellMs >= 60_000) {
			levels.push({ lower, upper, samples: samplesInLevel, dwellMs });
		}
	}

	return levels;
}

/** The smallest step between two adjacent power levels, or `undefined` */
export function smallestLevelStep(levels: PowerLevel[]): number | undefined {
	if (levels.length < 2) return undefined;
	let minStep = Infinity;
	for (let i = 1; i < levels.length; i++) {
		minStep = Math.min(minStep, levels[i].lower - levels[i - 1].upper);
	}
	return minStep === Infinity ? undefined : minStep;
}

//endregion

//region Suggestion computation

export interface SuggestionContext {
	/**
	 * The scales that are flooding this node, e.g. `["power"]`.
	 * Derived from per-scale Meter CC value-update counts.
	 */
	floodScales: string[];
	/** Recent power samples (value + timestamp), used to compute `T_jitter` and levels */
	powerSamples: { timestamp: number; value: number }[];
	/** The resolved configuration parameters that carry a reporting `$purpose` */
	params: readonly ReportingParam[];
	/** Current parameter values from the value DB, by parameter number */
	currentValues: Map<number, number | undefined>;
}

/**
 * A configuration parameter with reporting `$purpose`, as resolved from the
 * device config for this node's firmware.
 */
export interface ReportingParam {
	parameter: number;
	purpose: string;
	unit?: string;
	minValue: number;
	maxValue: number;
	defaultValue: number;
	recommendedValue?: number;
	options: readonly ConfigOption[];
	/** Allowed values, if defined in the config file */
	allowed?: readonly {
		value?: number;
		from?: number;
		to?: number;
		step?: number;
	}[];
}

/** Maps a ParamInformation to the subset the monitor cares about */
export function toReportingParam(param: ParamInformation): ReportingParam {
	return {
		parameter: param.parameterNumber,
		purpose: param.purpose!,
		unit: param.unit,
		minValue: param.minValue,
		maxValue: param.maxValue,
		defaultValue: param.defaultValue,
		recommendedValue: param.recommendedValue,
		options: param.options,
		allowed: param.allowed,
	};
}

function parsePurpose(
	purpose: string,
): { kind: "threshold" | "interval"; scale: string } | undefined {
	const match = /^reporting_(threshold|interval)\.(.+)$/.exec(purpose);
	if (!match) return undefined;
	return { kind: match[1] as "threshold" | "interval", scale: match[2] };
}

/** Computes the smallest real step between writable values of a parameter */
export function smallestParamStep(param: ReportingParam): number | undefined {
	const steps: number[] = [];
	if (param.allowed) {
		for (const def of param.allowed) {
			if ("step" in def && def.step != undefined) steps.push(def.step);
		}
	}
	if (param.options.length >= 2) {
		const values = [...new Set(param.options.map((o) => o.value))];
		values.sort((a, b) => a - b);
		for (let i = 1; i < values.length; i++) {
			steps.push(values[i] - values[i - 1]);
		}
	}
	if (steps.length === 0) return undefined;
	return Math.min(...steps);
}

/** Rounds up to the next multiple of `step` */
export function roundUpTo(value: number, step: number): number {
	if (step <= 0) return value;
	return Math.ceil(value / step) * step;
}

function percentile(sortedValues: number[], p: number): number | undefined {
	if (sortedValues.length === 0) return undefined;
	const idx = Math.max(0, Math.ceil(p * sortedValues.length) - 1);
	return sortedValues.at(Math.min(idx, sortedValues.length - 1));
}

/** Whether an interval parameter is explicitly disabled (value 0 with a "Disabled" option) */
export function isDisabledInterval(
	param: ReportingParam,
	currentValue: number | undefined,
): boolean {
	if (currentValue !== 0) return false;
	return param.options.some((o) =>
		o.label.trim().toLowerCase().startsWith("disabled"),
	);
}

/**
 * Computes the suggested configuration changes for a single loud node.
 *
 * Threshold rows are only offered for the `power` scale (the jitter math is
 * defined for power reports); for other scales a `recommendedValue` from the
 * config file is used if present. Interval rows are offered for every enabled
 * interval parameter whose current value is below the target interval.
 * Interval parameters that are explicitly disabled are never enabled.
 */
export function computeSuggestionRows(
	ctx: SuggestionContext,
	_now: number,
): MaintenanceSuggestionRow[] {
	const rows: MaintenanceSuggestionRow[] = [];

	// Power deltas in the window
	const powerDeltas: number[] = [];
	for (let i = 1; i < ctx.powerSamples.length; i++) {
		powerDeltas.push(
			Math.abs(ctx.powerSamples[i].value - ctx.powerSamples[i - 1].value),
		);
	}
	const sortedDeltas = powerDeltas.toSorted((a, b) => a - b);
	const p95 = percentile(sortedDeltas, 0.95);

	// Power levels (real-load step exception)
	const levels = clusterPowerLevels(ctx.powerSamples);
	const step = smallestLevelStep(levels);
	const stepCap = step != undefined ? 0.5 * step : undefined;
	const levelsRefuse =
		stepCap != undefined && p95 != undefined && 3 * p95 > stepCap;

	// Reference level for the percent variant
	const sortedPowerValues = ctx.powerSamples
		.map((s) => s.value)
		.toSorted((a, b) => a - b);
	const medianPower = percentile(sortedPowerValues, 0.5) ?? 0;

	for (const param of ctx.params) {
		const purpose = parsePurpose(param.purpose);
		if (!purpose) continue;
		if (!ctx.floodScales.includes(purpose.scale)) continue;

		const currentValue = ctx.currentValues.get(param.parameter);

		if (purpose.kind === "threshold") {
			// Only the power threshold is computed from jitter; other scales
			// fall back to the config's recommendedValue, if any.
			let proposed: number | undefined;
			const unitScale = classifyThresholdUnit(param.unit);
			if (purpose.scale === "power" && unitScale === "power") {
				proposed =
					param.recommendedValue
					?? (p95 != undefined ? roundUpTo(3 * p95, 5) : undefined);
			} else if (purpose.scale === "power" && unitScale === "percent") {
				if (param.recommendedValue != undefined) {
					proposed = param.recommendedValue;
				} else if (p95 != undefined && medianPower > 0) {
					const relativeDeltas = sortedDeltas.map(
						(d) => d / medianPower,
					);
					const relP95 = percentile(relativeDeltas, 0.95)!;
					proposed = roundUpTo(3 * relP95 * 100, 5);
				}
			} else {
				proposed = param.recommendedValue;
			}
			if (proposed == undefined) continue;

			// Apply caps: T = min(T_jitter, param max, 0.5 * smallest real step)
			proposed = Math.min(proposed, param.maxValue);
			const paramStep = smallestParamStep(param);
			if (paramStep != undefined) {
				proposed = Math.min(proposed, 0.5 * paramStep);
			}
			if (stepCap != undefined) proposed = Math.min(proposed, stepCap);
			proposed = Math.max(proposed, param.minValue);

			const row: MaintenanceSuggestionRow = {
				parameter: param.parameter,
				purpose: param.purpose,
				kind: "threshold",
				unit: param.unit,
				currentValue,
				defaultValue: param.defaultValue,
				proposedValue: proposed,
				minValue: param.minValue,
				maxValue: param.maxValue,
				stillAtFactoryDefault: currentValue === param.defaultValue,
				needsGet: currentValue == undefined,
			};

			if (levelsRefuse && step != undefined) {
				// The threshold row is refused, but intervals are still offered
				row.refusedReason = `This plug reports a real load that switches between ${Math.round(
					levels[0].lower,
				)} W and ${Math.round(levels.at(-1)!.upper)} W. Raising its threshold would hide those changes.`;
			} else if (currentValue != undefined && proposed <= currentValue) {
				// Only raise, never lower
				continue;
			}
			rows.push(row);
		} else {
			// Interval parameter
			if (isDisabledInterval(param, currentValue)) continue;
			const targetMs =
				purpose.scale === "power"
					? REPORT_FLOOD_POWER_INTERVAL_MS
					: REPORT_FLOOD_OTHER_INTERVAL_MS;
			const targetValue = msToIntervalUnit(targetMs, param.unit);
			if (targetValue == undefined) continue;

			let proposed = Math.min(
				Math.max(targetValue, param.minValue),
				param.maxValue,
			);
			if (
				currentValue != undefined
				&& intervalValueToMs(currentValue, param.unit) != undefined
				&& proposed <= currentValue
			) {
				// Already at or above the target interval
				continue;
			}

			rows.push({
				parameter: param.parameter,
				purpose: param.purpose,
				kind: "interval",
				unit: param.unit,
				currentValue,
				defaultValue: param.defaultValue,
				proposedValue: proposed,
				minValue: param.minValue,
				maxValue: param.maxValue,
				stillAtFactoryDefault: currentValue === param.defaultValue,
				needsGet: currentValue == undefined,
			});
		}
	}

	return rows;
}

//endregion

//region Per-node traffic record

interface NodeRecord {
	/** Inbound command counts per absolute bucket index */
	rxCounts: Map<number, number>;
	/** Meter CC value-update counts per scale, per absolute bucket index */
	scaleCounts: Map<string, Map<number, number>>;
	/** Recent power values (only tracked above half the loud line) */
	powerSamples: { timestamp: number; value: number }[];
	/** When the last report was received from this node */
	lastRX: number;
}

//endregion

//region Monitor

export interface ReportFloodMonitorOptions {
	/** Injectable clock, defaults to `Date.now` */
	now?: () => number;
	/** Called when a finding appears, changes or resolves */
	onFindingEvent?: (
		event: MaintenanceFindingEvent,
		finding: MaintenanceFinding,
	) => void;
	/**
	 * Returns the reporting-tagged config params for a node, resolved for its
	 * firmware. Called when a finding is raised or updated.
	 */
	getReportingParams?: (nodeId: number) => Promise<ReportingParam[]>;
	/** Reads a config parameter value from the value DB */
	getNodeValue?: (nodeId: number, parameter: number) => number | undefined;
	/**
	 * Sends a single cache-bypassing Configuration Get and resolves with the
	 * device's answer (or `undefined` if it did not respond).
	 */
	queryConfigParam?: (
		nodeId: number,
		parameter: number,
	) => Promise<number | undefined>;
}

export class ReportFloodMonitor {
	public constructor(options: ReportFloodMonitorOptions = {}) {
		this._options = options;
		this._now = options.now ?? (() => Date.now());
	}

	private _options: ReportFloodMonitorOptions;
	private _now: () => number;
	private _startedAt: number | undefined;

	private _nodeRecords: Map<number, NodeRecord> = new Map();
	/** Jam/unresponsive episodes (ended and open) */
	private _jamEpisodes: JamEpisode[] = [];
	/** Timestamps of jammed transmit attempts (24 h retention) */
	private _jammedTransmitAttempts: number[] = [];
	/** Per node: state of the verification after applying a suggestion */
	private _verification: Map<string, MaintenanceVerification> = new Map();
	private _findings: Map<MaintenanceFindingKind, MaintenanceFinding> =
		new Map();

	private getNodeRecord(nodeId: number): NodeRecord {
		let record = this._nodeRecords.get(nodeId);
		if (!record) {
			record = {
				rxCounts: new Map(),
				scaleCounts: new Map(),
				powerSamples: [],
				lastRX: 0,
			};
			this._nodeRecords.set(nodeId, record);
		}
		return record;
	}

	private pruneBuckets(counts: Map<number, number>, now: number): void {
		const minBucket = bucketIndex(now) - REPORT_FLOOD_BUCKET_COUNT + 1;
		for (const key of counts.keys()) {
			if (key < minBucket) counts.delete(key);
		}
	}

	/** Starts the monitor. No findings are raised during the first 60 minutes. */
	public start(): void {
		this._startedAt = this._now();
	}

	public stop(): void {
		this._startedAt = undefined;
		this._findings.clear();
		this._verification.clear();
	}

	/** Records one inbound command (a frame containing a CC) for a node */
	public recordRX(nodeId: number, timestamp?: number): void {
		const now = timestamp ?? this._now();
		const record = this.getNodeRecord(nodeId);
		const idx = bucketIndex(now);
		record.rxCounts.set(idx, (record.rxCounts.get(idx) ?? 0) + 1);
		record.lastRX = Math.max(record.lastRX, now);
		this.pruneBuckets(record.rxCounts, now);
	}

	/** Records a Meter CC value update for a scale like "power" or "energy" */
	public recordMeterScaleUpdate(
		nodeId: number,
		scale: string,
		timestamp?: number,
	): void {
		const now = timestamp ?? this._now();
		const record = this.getNodeRecord(nodeId);
		let counts = record.scaleCounts.get(scale);
		if (!counts) {
			counts = new Map();
			record.scaleCounts.set(scale, counts);
		}
		const idx = bucketIndex(now);
		counts.set(idx, (counts.get(idx) ?? 0) + 1);
		this.pruneBuckets(counts, now);
	}

	/**
	 * Records a power value. Values are only kept for nodes above half the
	 * loud line, and only the last 256 values are retained.
	 */
	public recordPowerValue(
		nodeId: number,
		value: number,
		timestamp?: number,
	): void {
		const now = timestamp ?? this._now();
		if (this.nodeRate60Min(nodeId, now) < REPORT_FLOOD_POWER_TRACK_RATE) {
			return;
		}
		const record = this.getNodeRecord(nodeId);
		record.powerSamples.push({ timestamp: now, value });
		if (record.powerSamples.length > REPORT_FLOOD_POWER_HISTORY) {
			record.powerSamples.splice(
				0,
				record.powerSamples.length - REPORT_FLOOD_POWER_HISTORY,
			);
		}
	}

	/** Records a controller status transition for jam accounting */
	public recordControllerStatus(
		status:
			| ControllerStatus.Jammed
			| ControllerStatus.Unresponsive
			| ControllerStatus.Ready,
		timestamp?: number,
	): void {
		const now = timestamp ?? this._now();
		const openEpisode =
			this._jamEpisodes.length > 0 ? this._jamEpisodes.at(-1) : undefined;
		const isOpen =
			openEpisode != undefined && openEpisode.end === openEpisode.start;

		if (
			status === ControllerStatus.Jammed
			|| status === ControllerStatus.Unresponsive
		) {
			if (!isOpen) {
				this._jamEpisodes.push({ start: now, end: now });
			}
		} else if (status === ControllerStatus.Ready) {
			if (isOpen && openEpisode) openEpisode.end = now;
		}
		this.pruneJamData(now);
	}

	/** Records a transmit attempt that failed because the controller was jammed */
	public recordJammedTransmitAttempt(timestamp?: number): void {
		const now = timestamp ?? this._now();
		this._jammedTransmitAttempts.push(now);
		this.pruneJamData(now);
	}

	private pruneJamData(now: number): void {
		const minTime = now - 24 * 60 * 60 * 1000;
		this._jamEpisodes = this._jamEpisodes.filter(
			(e) => e.end >= minTime || e.end === e.start,
		);
		this._jammedTransmitAttempts = this._jammedTransmitAttempts.filter(
			(t) => t >= minTime,
		);
	}

	/** Sum of all rx counts over the trailing window, optionally excluding jam buckets */
	private windowSum(
		counts: Map<number, number>,
		now: number,
		windowMs: number,
		excludeJams: boolean,
	): number {
		const minTime = now - windowMs;
		const minBucket = Math.floor(minTime / REPORT_FLOOD_BUCKET_MS);
		const maxBucket = bucketIndex(now);
		let sum = 0;
		for (const [idx, count] of counts) {
			if (idx < minBucket || idx > maxBucket) continue;
			if (excludeJams && this.bucketOverlapsJam(idx)) continue;
			sum += count;
		}
		return sum;
	}

	private bucketOverlapsJam(bucketIdx: number): boolean {
		const start = bucketIdx * REPORT_FLOOD_BUCKET_MS;
		const end = start + REPORT_FLOOD_BUCKET_MS;
		for (const episode of this._jamEpisodes) {
			const exStart = episode.start;
			const exEnd =
				Math.max(episode.end, episode.start)
				+ REPORT_FLOOD_JAM_EXCLUSION_PAD_MS;
			if (start < exEnd && end > exStart) return true;
		}
		return false;
	}

	/**
	 * A node's inbound rate (frames/h) since the given point in time,
	 * extrapolated to a full hour.
	 */
	public nodeRateSince(nodeId: number, since: number, now?: number): number {
		now = now ?? this._now();
		if (now <= since) return 0;
		const record = this._nodeRecords.get(nodeId);
		if (!record) return 0;
		let sum = 0;
		const minBucket = Math.floor(since / REPORT_FLOOD_BUCKET_MS);
		const maxBucket = bucketIndex(now);
		for (const [idx, count] of record.rxCounts) {
			if (idx < minBucket || idx > maxBucket) continue;
			sum += count;
		}
		// Scale the count to a full hour
		return sum * ((60 * 60 * 1000) / (now - since));
	}

	/** A node's inbound rate (frames/h) over the trailing 60 min, excluding jam buckets */
	public nodeRate60Min(nodeId: number, now?: number): number {
		now = now ?? this._now();
		const record = this._nodeRecords.get(nodeId);
		if (!record) return 0;
		return this.windowSum(record.rxCounts, now, 60 * 60 * 1000, true);
	}

	/** The total inbound rate (frames/h) over the trailing 60 min */
	public networkRate60Min(now?: number): number {
		now = now ?? this._now();
		let sum = 0;
		for (const record of this._nodeRecords.values()) {
			sum += this.windowSum(record.rxCounts, now, 60 * 60 * 1000, false);
		}
		return sum;
	}

	/** Inbound rate (frames/h) per hour window over the trailing 24 h */
	public networkHourlyRates(now?: number): number[] {
		now = now ?? this._now();
		const rates: number[] = [];
		const bucketSums = new Map<number, number>();
		const minTime = now - 24 * 60 * 60 * 1000;
		for (const record of this._nodeRecords.values()) {
			for (const [idx, count] of record.rxCounts) {
				bucketSums.set(idx, (bucketSums.get(idx) ?? 0) + count);
			}
		}
		// Only count complete hours (4 buckets each) inside the trailing 24 h
		const currentBucket = bucketIndex(now);
		const hoursStart = Math.ceil(minTime / (60 * 60 * 1000));
		const hoursEnd = Math.floor(now / (60 * 60 * 1000));
		for (let h = hoursStart; h < hoursEnd; h++) {
			let sum = 0;
			let complete = true;
			for (let b = 0; b < 4; b++) {
				const idx = h * 4 + b;
				if (idx > currentBucket) {
					complete = false;
					break;
				}
				sum += bucketSums.get(idx) ?? 0;
			}
			if (complete) rates.push(sum);
		}
		return rates;
	}

	/** (timeJammed + timeUnresponsive) over the trailing 24 h, in ms */
	public jamTime24h(now?: number): number {
		now = now ?? this._now();
		const minTime = now - 24 * 60 * 60 * 1000;
		let total = 0;
		for (const episode of this._jamEpisodes) {
			const start = Math.max(episode.start, minTime);
			const end = Math.min(
				episode.end === episode.start ? now : episode.end,
				now,
			);
			if (end > start) total += end - start;
		}
		return total;
	}

	/** The longest single jam episode within the trailing 24 h, in ms */
	public longestJamEpisode24h(now?: number): number {
		now = now ?? this._now();
		const minTime = now - 24 * 60 * 60 * 1000;
		let longest = 0;
		for (const episode of this._jamEpisodes) {
			const start = Math.max(episode.start, minTime);
			const end = Math.min(
				episode.end === episode.start ? now : episode.end,
				now,
			);
			longest = Math.max(longest, end - start);
		}
		return longest;
	}

	/** The number of jammed transmit attempts in the trailing 24 h */
	public jammedTransmitAttempts24h(now?: number): number {
		now = now ?? this._now();
		const minTime = now - 24 * 60 * 60 * 1000;
		return this._jammedTransmitAttempts.filter((t) => t >= minTime).length;
	}

	/** Which scales are flooding a node (at least 10% of its inbound traffic) */
	public floodScales(nodeId: number, now?: number): string[] {
		now = now ?? this._now();
		const record = this._nodeRecords.get(nodeId);
		if (!record) return [];
		const total = this.windowSum(
			record.rxCounts,
			now,
			60 * 60 * 1000,
			false,
		);
		if (total === 0) return [];
		const result: string[] = [];
		for (const [scale, counts] of record.scaleCounts) {
			const scaleCount = this.windowSum(
				counts,
				now,
				60 * 60 * 1000,
				false,
			);
			if (scaleCount / total >= REPORT_FLOOD_SCALE_SHARE) {
				result.push(scale);
			}
		}
		return result;
	}

	/** A node's loudness: rate >= 360/h and >= 10% of network inbound */
	public isLoudNode(nodeId: number, now?: number): boolean {
		now = now ?? this._now();
		const rate = this.nodeRate60Min(nodeId, now);
		if (rate < REPORT_FLOOD_LOUD_NODE_RATE) return false;
		const network = this.networkRate60Min(now);
		if (network === 0) return false;
		return rate / network >= REPORT_FLOOD_NODE_SHARE;
	}

	public loudNodes(now?: number): number[] {
		now = now ?? this._now();
		const result: number[] = [];
		for (const nodeId of this._nodeRecords.keys()) {
			if (this.isLoudNode(nodeId, now)) result.push(nodeId);
		}
		return result;
	}

	/**
	 * Evaluates all detection rules and updates the set of findings.
	 * Call this periodically (e.g. every few minutes) and after traffic was recorded.
	 */
	public async evaluate(): Promise<void> {
		const now = this._now();
		// Warmup: no findings in the first 60 min
		const warmedUp =
			this._startedAt != undefined
			&& now - this._startedAt >= REPORT_FLOOD_WARMUP_MS;
		const loud = this.loudNodes(now);

		const warningActive =
			warmedUp
			&& this.networkHourlyRates(now).filter(
				(r) => r >= REPORT_FLOOD_NETWORK_RATE,
			).length >= REPORT_FLOOD_NETWORK_HOURS
			&& loud.length >= 1;

		const errorActive =
			warmedUp
			&& loud.length >= 1
			&& (this.jamTime24h(now)
				>= REPORT_FLOOD_JAM_SHARE * 24 * 60 * 60 * 1000
				|| this.longestJamEpisode24h(now) >= REPORT_FLOOD_JAM_EPISODE_MS
				|| this.jammedTransmitAttempts24h(now)
					>= REPORT_FLOOD_JAM_ATTEMPTS);

		await this.updateFinding(
			"loud-network",
			"warning",
			warningActive,
			"Inbound Z-Wave traffic exceeded 1,000 frames/hour in at least 3 of the last 24 hours.",
			loud,
			now,
		);
		await this.updateFinding(
			"jammed",
			"error",
			errorActive,
			"The controller was jammed while nodes were sending an excessive number of reports.",
			loud,
			now,
		);
	}

	private async updateFinding(
		kind: MaintenanceFindingKind,
		severity: MaintenanceFindingSeverity,
		active: boolean,
		reason: string,
		loudNodeIds: number[],
		now: number,
	): Promise<void> {
		const existing = this._findings.get(kind);

		if (!active) {
			if (existing) {
				this._findings.delete(kind);
				this.emitEvent("maintenance finding resolved", existing);
			}
			return;
		}

		const nodes: MaintenanceNodeFinding[] = [];
		for (const nodeId of loudNodeIds) {
			nodes.push(await this.buildNodeFinding(nodeId, now));
		}

		if (!existing) {
			const finding: MaintenanceFinding = {
				id: `report-flood-${kind}`,
				kind,
				severity,
				reason,
				nodes,
				verification: [],
				createdAt: now,
				updatedAt: now,
			};
			this._findings.set(kind, finding);
			this.emitEvent("maintenance finding", finding);
		} else {
			existing.nodes = nodes;
			existing.reason = reason;
			existing.updatedAt = now;
			this.emitEvent("maintenance finding updated", existing);
		}
	}

	private async buildNodeFinding(
		nodeId: number,
		now: number,
	): Promise<MaintenanceNodeFinding> {
		const rate = this.nodeRate60Min(nodeId, now);
		const network = this.networkRate60Min(now);

		const params = (await this._options.getReportingParams?.(nodeId)) ?? [];
		if (params.length === 0) {
			// Untagged node: finding without numbers
			return {
				nodeId,
				hourlyRate: rate,
				shareOfInbound: network > 0 ? rate / network : 0,
				hasTaggedParams: false,
				untaggedNote:
					"This device's config file lacks report-parameter tags, so no specific settings can be suggested.",
				suggestionRows: [],
			};
		}

		const currentValues = new Map<number, number | undefined>();
		for (const param of params) {
			currentValues.set(
				param.parameter,
				this._options.getNodeValue?.(nodeId, param.parameter),
			);
		}

		const record = this._nodeRecords.get(nodeId);
		const rows = computeSuggestionRows(
			{
				floodScales: this.floodScales(nodeId, now),
				powerSamples: record?.powerSamples ?? [],
				params,
				currentValues,
			},
			now,
		);

		return {
			nodeId,
			hourlyRate: rate,
			shareOfInbound: network > 0 ? rate / network : 0,
			hasTaggedParams: true,
			suggestionRows: rows,
		};
	}

	public getFindings(): readonly MaintenanceFinding[] {
		return [...this._findings.values()];
	}

	public getFinding(findingId: string): MaintenanceFinding | undefined {
		return this._findings.get(
			findingId.replace(/^report-flood-/, "") as MaintenanceFindingKind,
		);
	}

	private emitEvent(
		event: MaintenanceFindingEvent,
		finding: MaintenanceFinding,
	): void {
		this._options.onFindingEvent?.(event, finding);
	}

	//region Applying suggestions and verification

	/**
	 * Applies the suggested configuration changes for one node of a finding by
	 * writing all offered (non-refused) rows. For rows whose current value is
	 * unknown, a single Configuration Get is sent first.
	 *
	 * This is the explicit user action - the monitor never applies anything on its own.
	 */
	public async applySuggestion(
		findingId: string,
		nodeId: number,
		write: (
			nodeId: number,
			parameter: number,
			value: number,
		) => Promise<{ setOK: boolean }>,
	): Promise<MaintenanceVerification> {
		const finding = this.getFinding(findingId);
		if (!finding) {
			throw new Error(`Unknown maintenance finding: ${findingId}`);
		}
		const nodeFinding = finding.nodes.find((n) => n.nodeId === nodeId);
		if (!nodeFinding) {
			throw new Error(
				`Node ${nodeId} is not part of maintenance finding ${findingId}`,
			);
		}

		let anyWriteFailed = false;
		for (const row of nodeFinding.suggestionRows) {
			if (row.refusedReason) continue;

			let currentValue = row.currentValue;
			if (row.needsGet && this._options.queryConfigParam) {
				currentValue = await this._options.queryConfigParam(
					nodeId,
					row.parameter,
				);
			}
			if (
				currentValue != undefined
				&& row.kind === "threshold"
				&& row.proposedValue <= currentValue
			) {
				continue; // only raise, never lower
			}

			const result = await write(
				nodeId,
				row.parameter,
				row.proposedValue,
			);
			if (!result.setOK) anyWriteFailed = true;
		}

		const now = this._now();
		const preWriteRate = this.nodeRate60Min(nodeId, now);
		const verification: MaintenanceVerification = {
			nodeId,
			state: anyWriteFailed ? "rejected" : "verifying",
			message: anyWriteFailed
				? "The plug refused the change."
				: "Checking traffic…",
			preWriteRate,
			appliedAt: now,
			retriesLeft: 1,
		};
		this._verification.set(`${findingId}:${nodeId}`, verification);
		finding.verification = finding.verification.filter(
			(v) => v.nodeId !== nodeId,
		);
		finding.verification.push(verification);
		this.emitEvent("maintenance finding updated", finding);
		return verification;
	}

	/**
	 * Advances the verification state machine for all nodes with an applied
	 * suggestion. `getQueryResult` must send a single cache-bypassing
	 * Configuration Get and return the device's answer.
	 */
	public async tickVerification(
		getConfigParam: (
			nodeId: number,
			parameter: number,
		) => Promise<number | undefined>,
		lastWrittenRow: (
			findingId: string,
			nodeId: number,
		) => MaintenanceSuggestionRow | undefined,
	): Promise<void> {
		const now = this._now();
		for (const [key, verification] of this._verification) {
			const [findingId, nodeIdStr] = key.split(":");
			const nodeId = parseInt(nodeIdStr, 10);
			const finding = this.getFinding(findingId);
			if (!finding) {
				this._verification.delete(key);
				continue;
			}
			const elapsed = now - verification.appliedAt;

			if (verification.state === "verifying") {
				if (elapsed < REPORT_FLOOD_VERIFY_START_MS) continue;
				if (elapsed > REPORT_FLOOD_VERIFY_END_MS) {
					await this.resolveUnchanged(
						verification,
						finding,
						nodeId,
						getConfigParam,
						lastWrittenRow,
					);
				} else {
					// Measure the rate since the change was applied,
					// but only once the window has had time to develop
					const hourlyRate = this.nodeRateSince(
						nodeId,
						verification.appliedAt + REPORT_FLOOD_VERIFY_START_MS,
						now,
					);
					const loadActive = this.hasRecentTraffic(nodeId, now);
					if (
						hourlyRate <= 0.25 * verification.preWriteRate
						&& hourlyRate < REPORT_FLOOD_LOUD_NODE_RATE
						&& loadActive
					) {
						this.setVerificationState(
							finding,
							verification,
							"verified (provisional)",
							`Traffic from this plug dropped from ${Math.round(
								verification.preWriteRate,
							)}/h to ${Math.round(hourlyRate)}/h.`,
						);
					} else if (!loadActive) {
						this.setVerificationState(
							finding,
							verification,
							"inconclusive (idle)",
							"Waiting for the load to run.",
						);
					}
				}
			} else if (verification.state === "inconclusive (idle)") {
				if (
					now - verification.appliedAt
					> REPORT_FLOOD_VERIFY_LONG_MS
				) {
					// Give up after 24 h
					this._verification.delete(key);
				} else if (this.hasRecentTraffic(nodeId, now)) {
					// Re-test at the next active window
					this.setVerificationState(
						finding,
						verification,
						"verifying",
						"Checking traffic…",
					);
				}
			} else if (
				verification.state === "verified (provisional)"
				&& elapsed >= REPORT_FLOOD_VERIFY_LONG_MS
			) {
				const rate = this.nodeRate60Min(nodeId, now);
				if (rate >= REPORT_FLOOD_LOUD_NODE_RATE) {
					this.setVerificationState(
						finding,
						verification,
						"regressed",
						"The change did not stick (for example after a power loss).",
					);
				} else {
					this.setVerificationState(
						finding,
						verification,
						"verified",
						`Traffic from this plug stayed low at ${Math.round(rate)}/h.`,
					);
				}
			}
		}
	}

	private async resolveUnchanged(
		verification: MaintenanceVerification,
		finding: MaintenanceFinding,
		nodeId: number,
		getConfigParam: (
			nodeId: number,
			parameter: number,
		) => Promise<number | undefined>,
		lastWrittenRow: (
			findingId: string,
			nodeId: number,
		) => MaintenanceSuggestionRow | undefined,
	): Promise<void> {
		// The load counts as idle when nothing was heard from the node
		// since the change was applied
		if (!this.hasRecentTraffic(nodeId, this._now())) {
			this.setVerificationState(
				finding,
				verification,
				"inconclusive (idle)",
				"Waiting for the load to run.",
			);
			return;
		}

		// Measure the rate since the change was applied
		const rate = this.nodeRateSince(nodeId, verification.appliedAt);
		const dropped =
			rate <= 0.25 * verification.preWriteRate
			&& rate < REPORT_FLOOD_LOUD_NODE_RATE;
		if (dropped) {
			this.setVerificationState(
				finding,
				verification,
				"verified (provisional)",
				`Traffic from this plug dropped from ${Math.round(
					verification.preWriteRate,
				)}/h to ${Math.round(rate)}/h.`,
			);
			return;
		}

		// No drop: read the setting back with a cache-bypassing Get
		const row = lastWrittenRow(finding.id, nodeId);
		const written = row?.proposedValue;
		let getResult: MaintenanceVerification["getResult"];
		let readValue: number | undefined;
		if (row && written != undefined) {
			readValue = await getConfigParam(nodeId, row.parameter);
			if (readValue == undefined) {
				getResult = "no answer";
			} else {
				getResult = readValue === written ? "new" : "old";
			}
		} else {
			getResult = "no answer";
		}

		if (getResult === "old") {
			if (verification.retriesLeft > 0) {
				verification.retriesLeft--;
				// One retry: go back to verifying
				this.setVerificationState(
					finding,
					verification,
					"verifying",
					"Checking traffic…",
				);
			} else {
				this.setVerificationState(
					finding,
					verification,
					"not stored",
					"The plug said OK but kept its old setting.",
				);
			}
		} else if (getResult === "new") {
			this.setVerificationState(
				finding,
				verification,
				"stored, no effect",
				"The setting took, but this plug is loud for another reason.",
			);
		} else {
			this.setVerificationState(
				finding,
				verification,
				"unconfirmed",
				"Could not read the setting back.",
			);
		}
	}

	private hasRecentTraffic(nodeId: number, now: number): boolean {
		const record = this._nodeRecords.get(nodeId);
		if (!record) return false;
		// The load counts as active if any report arrived in the last 15 minutes
		return now - record.lastRX <= 15 * 60 * 1000;
	}

	private setVerificationState(
		finding: MaintenanceFinding,
		verification: MaintenanceVerification,
		state: MaintenanceVerificationState,
		message: string,
	): void {
		verification.state = state;
		verification.message = message;
		finding.updatedAt = this._now();
		this.emitEvent("maintenance finding updated", finding);
	}

	//endregion
}

//endregion

function bucketIndex(t: number): number {
	return Math.floor(t / REPORT_FLOOD_BUCKET_MS);
}

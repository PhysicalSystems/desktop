var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// ../harness-gripper-check/packages/operator-service/src/service.js
import { createHash as createHash8, randomBytes, randomUUID as randomUUID5 } from "node:crypto";
import { mkdir as mkdir2, lstat } from "node:fs/promises";
import path4 from "node:path";

// ../harness-gripper-check/packages/cli/src/harness/experiments/controller.js
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";

// ../harness-gripper-check/packages/cli/src/harness/experiments/fixture.js
var experimentFixture = Object.freeze({
  id: "synthetic-alignment-v1",
  name: "Synthetic alignment",
  description: "Try a horizontal offset and compare its absolute distance from a fixed synthetic target at 3 mm.",
  input: { name: "offsetMm", unit: "mm", minimum: -10, maximum: 10 },
  metric: {
    name: "alignmentErrorMm",
    unit: "mm",
    lowerIsBetter: true,
    signedMeasurement: { name: "signedErrorMm", meaning: "Synthetic target minus the submitted offset, in millimetres" }
  },
  limitations: [
    "Arithmetic simulation only: no devices, cameras, physics, learned policy or hardware execution.",
    "The target is deliberately disclosed at 3 mm. This fixture checks the experiment workflow, not autonomous discovery quality.",
    "Results do not establish physical readiness or authorize hardware access."
  ]
});
function runSyntheticTrial({ offsetMm, signal, stepMs }) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Synthetic trial cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve({ alignmentErrorMm: Math.abs(offsetMm - 3), signedErrorMm: 3 - offsetMm, source: experimentFixture.id });
    }, stepMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted)
      abort();
  });
}

// ../harness-gripper-check/packages/cli/src/harness/experiments/storage.js
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
var openStores = new Set;
var MAX_BYTES = 2 * 1024 * 1024;
function assertDirectory(directory) {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current))
      mkdirSync(current, { mode: 448 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Experiment storage must use real directories, without symbolic links");
  }
}
function assertRegular(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
    throw new Error("Experiment storage contains an unsupported file");
  return true;
}
function createExperimentStore({ storageDir, sessionId }) {
  if (typeof storageDir !== "string" || !storageDir.trim())
    throw new TypeError("A private experiment storage directory is required");
  const directory = resolve(storageDir);
  assertDirectory(directory);
  const basename = createHash("sha256").update(sessionId).digest("hex");
  const file = join(directory, `${basename}.json`);
  const lock = join(directory, `${basename}.lock`);
  if (openStores.has(file))
    throw new Error("This conversation already owns an experiment controller");
  let lockFd;
  try {
    lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 384);
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
    assertRegular(lock);
    let owner;
    try {
      owner = JSON.parse(readFileSync(lock, "utf8"));
    } catch {
      throw new Error("Experiment storage lock is unreadable; preserve it for inspection");
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
      throw new Error("Experiment storage lock is invalid; preserve it for inspection");
    try {
      process.kill(owner.pid, 0);
      throw new Error("Another process owns this conversation’s experiments");
    } catch (failure) {
      if (failure.code !== "ESRCH")
        throw failure;
    }
    unlinkSync(lock);
    lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 384);
  }
  const ownerToken = randomUUID();
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: ownerToken }), "utf8");
  closeSync(lockFd);
  openStores.add(file);
  let released = false;
  const release = () => {
    if (released)
      return;
    released = true;
    openStores.delete(file);
    assertDirectory(directory);
    if (assertRegular(lock) && JSON.parse(readFileSync(lock, "utf8")).token === ownerToken)
      unlinkSync(lock);
  };
  const read = () => {
    assertDirectory(directory);
    if (!assertRegular(file))
      return null;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  };
  const write = (state) => {
    if (released)
      throw new Error("Experiment storage is closed");
    assertDirectory(directory);
    assertRegular(file);
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_BYTES)
      throw new Error("Experiment evidence storage is full; start a new conversation");
    const temporary = join(directory, `.${basename}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 384);
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      assertDirectory(dirname(file));
      assertRegular(file);
      renameSync(temporary, file);
    } finally {
      if (fd !== undefined)
        closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT")
          throw error;
      }
    }
  };
  return { read, write, release };
}

// ../harness-gripper-check/packages/cli/src/harness/experiments/controller.js
var TERMINAL = new Set(["COMPLETED", "STOPPED", "INTERRUPTED", "FAILED"]);
var PHASES = new Set(["PROPOSED", "READY", "RUNNING", "OUTCOME_UNKNOWN", ...TERMINAL]);
var MAX_HISTORY = 8;
var MAX_REQUESTS = 2048;
var APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
var clone = (value) => structuredClone(value);
var digest = (value) => createHash2("sha256").update(JSON.stringify(value)).digest("hex");

class LocalExperimentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalExperimentError";
    this.code = code;
  }
}
function failure(code, message) {
  return new LocalExperimentError(code, message);
}
function experimentRequestFailure(error) {
  if (!(error instanceof LocalExperimentError))
    return null;
  const status = error.code === "APPROVAL_EXPIRED" ? 410 : [
    "EXPERIMENT_CHANGED",
    "REQUEST_CONFLICT",
    "EXPERIMENT_BUSY",
    "PLAN_CHANGED",
    "APPROVAL_UNAVAILABLE",
    "APPROVAL_REQUIRED",
    "TRIAL_LIMIT_REACHED",
    "FINISH_UNAVAILABLE",
    "SESSION_REQUEST_LIMIT",
    "DISPOSED"
  ].includes(error.code) ? 409 : 400;
  return { status, code: error.code, message: error.message };
}
function identifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value))
    throw failure("INVALID_REQUEST", `${name} must be a nonempty identifier of at most 160 characters`);
  return value;
}
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
    throw failure("INVALID_REQUEST", "This experiment request contains unsupported fields");
}
function summary(experiment) {
  const measured = experiment.trials.filter((trial) => trial.status === "COMPLETED" && trial.result);
  const best = measured.reduce((value, trial) => !value || trial.result.alignmentErrorMm < value.result.alignmentErrorMm ? trial : value, null);
  return {
    completedTrials: measured.length,
    totalTrials: experiment.trials.length,
    bestTrialId: best?.id || null,
    bestOffsetMm: best?.offsetMm ?? null,
    bestAlignmentErrorMm: best?.result.alignmentErrorMm ?? null,
    interpretation: best ? `Lowest recorded synthetic alignment error: ${best.result.alignmentErrorMm} mm. Physical behavior is not verified.` : "No completed synthetic measurement is available."
  };
}
function assertStored(state, sessionId) {
  if (!state || state.schemaVersion !== 1 || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.history) || state.history.length > MAX_HISTORY || !Array.isArray(state.requests) || state.requests.length > MAX_REQUESTS)
    throw failure("STORAGE_INVALID", "Saved experiment metadata is invalid; preserve it for inspection");
  for (const experiment of [...state.history, ...state.current ? [state.current] : []]) {
    if (!experiment || experiment.mode !== "simulation" || !PHASES.has(experiment.phase) || typeof experiment.id !== "string" || typeof experiment.goal !== "string" || experiment.goal.length > 4000 || !Number.isInteger(experiment.trialLimit) || experiment.trialLimit < 1 || experiment.trialLimit > 10 || !Array.isArray(experiment.trials) || experiment.trials.length > experiment.trialLimit || !Number.isFinite(experiment.expiresAt))
      throw failure("STORAGE_INVALID", "Saved experiment state cannot be resumed safely; preserve it for inspection");
    const expected = digest({
      id: experiment.id,
      goal: experiment.goal,
      mode: "simulation",
      fixtureId: experimentFixture.id,
      trialLimit: experiment.trialLimit,
      expiresAt: experiment.expiresAt
    });
    if (experiment.planDigest !== expected)
      throw failure("STORAGE_INVALID", "Saved experiment plan does not match its digest; preserve it for inspection");
    for (const trial of experiment.trials) {
      if (!trial || typeof trial.id !== "string" || typeof trial.requestId !== "string" || typeof trial.offsetMm !== "number" || !Number.isFinite(trial.offsetMm) || trial.offsetMm < -10 || trial.offsetMm > 10 || !["RUNNING", "COMPLETED", "STOPPED", "FAILED", "INTERRUPTED", "OUTCOME_UNKNOWN"].includes(trial.status) || trial.result !== null && (!Number.isFinite(trial.result?.alignmentErrorMm) || trial.result.alignmentErrorMm < 0))
        throw failure("STORAGE_INVALID", "Saved trial metadata is invalid; preserve it for inspection");
    }
  }
  const ids = new Set;
  for (const request of state.requests) {
    if (!request || typeof request.id !== "string" || typeof request.fingerprint !== "string" || !["propose", "trial"].includes(request.kind) || !["PENDING", "SETTLED"].includes(request.status) || ids.has(request.id))
      throw failure("STORAGE_INVALID", "Saved request identity metadata is invalid; preserve it for inspection");
    ids.add(request.id);
  }
}
function createExperimentController({ sessionId, storageDir, now = Date.now, trialTimeoutMs = 2000, runTrialImpl, stepMs = 250 } = {}) {
  identifier(sessionId, "sessionId");
  if (!Number.isFinite(trialTimeoutMs) || trialTimeoutMs < 1 || trialTimeoutMs > 30000 || !Number.isFinite(stepMs) || stepMs < 0 || stepMs > 30000)
    throw new TypeError("Simulation time bounds must be finite and at most 30 seconds");
  if (runTrialImpl !== undefined && typeof runTrialImpl !== "function")
    throw new TypeError("The simulation runner must be a function");
  const store = createExperimentStore({ sessionId, storageDir });
  const builtin = !runTrialImpl;
  const runner = runTrialImpl || runSyntheticTrial;
  let state;
  try {
    state = store.read() || { schemaVersion: 1, sessionId, revision: 0, current: null, history: [], requests: [] };
    assertStored(state, sessionId);
  } catch (error) {
    store.release();
    throw error;
  }
  let disposed = false, active = null, storageFailed = false;
  const listeners = new Set;
  const timestamp = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0)
      throw failure("INVALID_CLOCK", "Experiment clock is unavailable");
    return value;
  };
  const snapshot = () => clone({
    sessionId,
    availability: "simulation-only",
    revision: state.revision,
    fixture: experimentFixture,
    current: state.current,
    history: state.history.map((item) => ({ ...item, goal: item.goal.slice(0, 400) })),
    error: storageFailed ? "Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence." : null,
    physicalExecutionAuthorized: false
  });
  const emit = () => {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {}
    }
  };
  const save = () => {
    if (disposed)
      return;
    if (state.current)
      state.current.summary = summary(state.current);
    state.revision += 1;
    try {
      if (storageFailed)
        throw new Error("Experiment storage is unavailable");
      store.write(state);
    } catch {
      storageFailed = true;
      if (state.current) {
        state.current.phase = "OUTCOME_UNKNOWN";
        state.current.recoveryReason = "Experiment evidence could not be saved. Preserve local files, repair storage, then retry Stop after the synthetic runner has settled. No outcome is assumed.";
        const trial2 = state.current.trials.find((item) => item.id === active?.trialId);
        if (trial2) {
          trial2.status = "OUTCOME_UNKNOWN";
          trial2.result = null;
        }
      }
      active?.controller.abort();
      emit();
      throw failure("STORAGE_UNAVAILABLE", "Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence");
    }
    emit();
  };
  try {
    if (state.current && ["RUNNING", "READY", "OUTCOME_UNKNOWN"].includes(state.current.phase)) {
      const unknown = state.current.phase === "OUTCOME_UNKNOWN";
      state.current.phase = unknown ? "OUTCOME_UNKNOWN" : "INTERRUPTED";
      state.current.recoveryReason = unknown ? "A previous simulated trial did not confirm cleanup. This experiment remains blocked; inspect its evidence. No trial was replayed." : "This conversation was reopened. The previous approval was not resumed and no trial was replayed. Propose a new experiment to continue.";
      for (const trial2 of state.current.trials)
        if (trial2.status === "RUNNING") {
          trial2.status = unknown ? "OUTCOME_UNKNOWN" : "INTERRUPTED";
          trial2.finishedAt = timestamp();
        }
      for (const request of state.requests)
        if (request.status === "PENDING")
          request.status = "SETTLED";
      save();
    }
  } catch (error) {
    store.release();
    throw error;
  }
  const ensureOpen = (allowStorageFailure = false) => {
    if (disposed)
      throw failure("DISPOSED", "This experiment session is closed; reopen the conversation");
    if (storageFailed && !allowStorageFailure)
      throw failure("STORAGE_UNAVAILABLE", "Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence");
  };
  const current = (id, allowStorageFailure = false) => {
    ensureOpen(allowStorageFailure);
    if (!state.current || state.current.id !== id)
      throw failure("EXPERIMENT_CHANGED", "The experiment has changed. Refresh and review the current proposal before acting");
    return state.current;
  };
  const remember = (kind, id, payload) => {
    identifier(id, "requestId");
    const fingerprint = digest({ kind, ...payload });
    const known = state.requests.find((request) => request.id === id);
    if (known) {
      if (known.fingerprint !== fingerprint || known.kind !== kind)
        throw failure("REQUEST_CONFLICT", "This request identifier was already used for a different action. Refresh and submit a new request");
      return known;
    }
    if (state.requests.length >= MAX_REQUESTS)
      throw failure("SESSION_REQUEST_LIMIT", "This conversation has reached its experiment request limit. Start a new conversation; existing evidence is preserved");
    return null;
  };
  const settleRequest = (id) => {
    const request = state.requests.find((item) => item.id === id);
    if (request)
      request.status = "SETTLED";
  };
  const requireFresh = (experiment) => {
    if (timestamp() >= experiment.expiresAt)
      throw failure("APPROVAL_EXPIRED", "This experiment approval has expired. Stop it and propose a new bounded experiment for review");
  };
  function propose(body) {
    ensureOpen();
    fields(body, ["goal", "trialLimit", "requestId", "mode"]);
    const { goal, requestId, mode, trialLimit = 4 } = body;
    if (mode !== "simulation")
      throw failure("UNSUPPORTED_MODE", "Only the synthetic simulation is available. This action cannot authorize devices or hardware trials");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(goal))
      throw failure("INVALID_GOAL", "Describe the experiment goal in 1 to 4000 characters");
    if (!Number.isInteger(trialLimit) || trialLimit < 1 || trialLimit > 10)
      throw failure("INVALID_TRIAL_LIMIT", "Choose a bounded trial limit from 1 to 10");
    if (remember("propose", requestId, { goal: goal.trim(), mode, trialLimit }))
      return snapshot();
    if (active || state.current && !TERMINAL.has(state.current.phase))
      throw failure("EXPERIMENT_BUSY", "Finish or stop the current experiment before proposing another. An unconfirmed stop must settle first");
    if (state.current)
      state.history = [clone(state.current), ...state.history].slice(0, MAX_HISTORY);
    const id = randomUUID2(), expiresAt = timestamp() + APPROVAL_LIFETIME_MS;
    state.current = {
      id,
      goal: goal.trim(),
      mode,
      phase: "PROPOSED",
      trialLimit,
      expiresAt,
      planDigest: digest({ id, goal: goal.trim(), mode, fixtureId: experimentFixture.id, trialLimit, expiresAt }),
      createdAt: timestamp(),
      approvedAt: null,
      trials: [],
      summary: null
    };
    state.requests.push({ id: requestId, kind: "propose", fingerprint: digest({ kind: "propose", goal: goal.trim(), mode, trialLimit }), status: "SETTLED", experimentId: id });
    save();
    return snapshot();
  }
  function approve(body) {
    fields(body, ["experimentId", "expectedDigest"]);
    const experiment = current(body.experimentId);
    if (typeof body.expectedDigest !== "string" || body.expectedDigest !== experiment.planDigest)
      throw failure("PLAN_CHANGED", "The proposal does not match the reviewed plan. Refresh and review its exact goal and trial limit");
    requireFresh(experiment);
    if (experiment.phase === "READY")
      return snapshot();
    if (experiment.phase !== "PROPOSED")
      throw failure("APPROVAL_UNAVAILABLE", "Only the current proposed experiment can be approved");
    experiment.phase = "READY";
    experiment.approvedAt = timestamp();
    save();
    return snapshot();
  }
  function interrupt(kind) {
    const owner = active;
    if (!owner)
      return;
    clearTimeout(owner.timer);
    owner.interrupted ||= kind;
    kind = owner.interrupted;
    const experiment = state.current;
    const trial2 = experiment.trials.find((item) => item.id === owner.trialId);
    trial2.status = builtin ? kind === "stop" ? "STOPPED" : "FAILED" : "OUTCOME_UNKNOWN";
    trial2.finishedAt = timestamp();
    trial2.error = kind === "stop" ? "Stop requested. No successful measurement is assumed." : "The simulated trial exceeded its time limit. No successful measurement is assumed.";
    experiment.phase = builtin ? kind === "stop" ? "STOPPED" : "FAILED" : "OUTCOME_UNKNOWN";
    experiment.stopStatus = builtin ? "CONFIRMED" : "UNCONFIRMED";
    settleRequest(owner.requestId);
    if (builtin)
      active = null;
    owner.controller.abort();
    try {
      save();
    } catch {} finally {
      owner.resolve(snapshot());
    }
  }
  function trial(body) {
    ensureOpen();
    fields(body, ["experimentId", "requestId", "offsetMm"]);
    const { experimentId, requestId, offsetMm } = body;
    if (typeof offsetMm !== "number" || !Number.isFinite(offsetMm) || offsetMm < -10 || offsetMm > 10)
      throw failure("INVALID_TRIAL_INPUT", "Choose an offsetMm between -10 and 10 for the synthetic fixture");
    const known = remember("trial", requestId, { experimentId, offsetMm });
    if (known)
      return active?.requestId === requestId ? active.promise : Promise.resolve(snapshot());
    const experiment = current(experimentId);
    if (active || experiment.phase === "RUNNING" || experiment.phase === "OUTCOME_UNKNOWN")
      throw failure("EXPERIMENT_BUSY", "A simulated trial is active or its stop is unconfirmed. Wait for its outcome; Stop remains available");
    if (experiment.phase !== "READY")
      throw failure("APPROVAL_REQUIRED", "Review and approve this exact simulation proposal before running a trial");
    requireFresh(experiment);
    if (experiment.trials.length >= experiment.trialLimit)
      throw failure("TRIAL_LIMIT_REACHED", "The approved trial limit has been reached. Finish this experiment or propose a new one for review");
    const record = { id: randomUUID2(), requestId, offsetMm, status: "RUNNING", startedAt: timestamp(), finishedAt: null, result: null, error: null };
    experiment.trials.push(record);
    experiment.phase = "RUNNING";
    state.requests.push({ id: requestId, kind: "trial", fingerprint: digest({ kind: "trial", experimentId, offsetMm }), status: "PENDING", experimentId });
    const owner = { controller: new AbortController, trialId: record.id, requestId, interrupted: null, timer: null, resolve: null, promise: null };
    owner.promise = new Promise((resolve2) => {
      owner.resolve = resolve2;
    });
    active = owner;
    try {
      save();
    } catch (error) {
      active = null;
      owner.controller.abort();
      throw error;
    }
    owner.timer = setTimeout(() => {
      if (!disposed && active === owner)
        interrupt("timeout");
    }, trialTimeoutMs);
    const complete = (result, error) => {
      clearTimeout(owner.timer);
      if (disposed || active !== owner || state.current.id !== experimentId)
        return;
      active = null;
      record.finishedAt = timestamp();
      settleRequest(requestId);
      if (owner.interrupted) {
        record.status = owner.interrupted === "stop" ? "STOPPED" : "FAILED";
        experiment.phase = owner.interrupted === "stop" ? "STOPPED" : "FAILED";
        experiment.stopStatus = "CONFIRMED";
        record.error = "The simulated runner settled after cancellation. Its late result was discarded.";
      } else if (error || !result || !Number.isFinite(result.alignmentErrorMm) || result.alignmentErrorMm < 0) {
        record.status = "FAILED";
        experiment.phase = "FAILED";
        record.error = "The simulated runner failed or returned an invalid measurement. No hardware operation occurred. Inspect the trial and propose a new experiment to retry.";
      } else {
        record.status = "COMPLETED";
        experiment.phase = "READY";
        record.result = {
          alignmentErrorMm: result.alignmentErrorMm,
          ...Number.isFinite(result.signedErrorMm) ? { signedErrorMm: result.signedErrorMm } : {},
          source: experimentFixture.id
        };
      }
      save();
      owner.resolve(snapshot());
    };
    Promise.resolve().then(() => {
      if (owner.controller.signal.aborted)
        throw new Error("Trial stopped before dispatch");
      return runner({ offsetMm, signal: owner.controller.signal, stepMs, experimentId, trialId: record.id });
    }).then((result) => complete(result, null), (error) => complete(null, error)).catch(() => {
      if (!disposed && state.current?.id === experimentId) {
        experiment.phase = "OUTCOME_UNKNOWN";
        record.status = "OUTCOME_UNKNOWN";
        record.result = null;
        experiment.recoveryReason = "The trial could not persist its outcome. Preserve local evidence, repair storage, then retry Stop. Its unknown result will not be replayed or reported as success.";
        experiment.summary = summary(experiment);
        emit();
        owner.resolve(snapshot());
      }
    });
    return owner.promise;
  }
  function finish(body) {
    fields(body, ["experimentId"]);
    const experiment = current(body.experimentId);
    if (experiment.phase === "COMPLETED")
      return snapshot();
    if (active || experiment.phase !== "READY" || !experiment.trials.length)
      throw failure("FINISH_UNAVAILABLE", "Finish is available after an approved experiment has at least one settled trial. Stop is available while work is active");
    experiment.phase = "COMPLETED";
    experiment.finishedAt = timestamp();
    save();
    return snapshot();
  }
  function stop(body) {
    fields(body, ["experimentId"]);
    const experiment = current(body.experimentId, true);
    if (active) {
      interrupt("stop");
      return snapshot();
    }
    if (storageFailed) {
      experiment.phase = "STOPPED";
      experiment.stopStatus = "CONFIRMED";
      experiment.finishedAt = timestamp();
      experiment.recoveryReason = "Synthetic work is stopped and the retained evidence was saved after storage recovery. Any unknown trial outcome remains unknown; no trial was replayed.";
      storageFailed = false;
      try {
        save();
      } catch {}
      return snapshot();
    }
    if (experiment.phase === "OUTCOME_UNKNOWN")
      return snapshot();
    if (TERMINAL.has(experiment.phase))
      return snapshot();
    experiment.phase = "STOPPED";
    experiment.stopStatus = "CONFIRMED";
    experiment.finishedAt = timestamp();
    try {
      save();
    } catch {}
    return snapshot();
  }
  function dispose() {
    if (disposed)
      return;
    try {
      if (active)
        interrupt("stop");
    } finally {
      disposed = true;
      listeners.clear();
      store.release();
    }
  }
  return {
    snapshot,
    propose,
    approve,
    trial,
    finish,
    stop,
    dispose,
    subscribe(listener) {
      ensureOpen();
      if (typeof listener !== "function")
        throw new TypeError("A change listener is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
// ../harness-gripper-check/packages/cli/src/harness/experiments/tools.js
var EXPERIMENT_TOOL_ALLOWLIST = Object.freeze([
  "inspect_local_experiment",
  "propose_local_experiment",
  "run_simulated_trial",
  "finish_local_experiment"
]);
var id = { type: "string", minLength: 1, maxLength: 128 };
var schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
function createExperimentTools({ getController, defineTool = (value) => value }) {
  const definitions = [
    [
      "inspect_local_experiment",
      "Inspect local experiment",
      "Read this conversation’s synthetic experiment, fixed fixture, trial budget and recorded results. No hardware discovery or camera access. Simulation results do not establish robot performance.",
      schema({}),
      (controller) => controller.snapshot()
    ],
    [
      "propose_local_experiment",
      "Propose simulated experiment",
      "Propose a bounded synthetic alignment experiment, only with explicit mode simulation. This fixture is not robot physics, a learned policy or physical execution. Explain the goal, fixture and trial limit, then direct the operator to approve the exact plan in Experiments or /experiment approve. Conversation consent and ask_choice cannot approve. Use a stable requestId to avoid duplicate proposals.",
      schema({
        goal: { type: "string", minLength: 1, maxLength: 1000 },
        mode: { type: "string", enum: ["simulation"] },
        trialLimit: { type: "integer", minimum: 1, maximum: 10 },
        requestId: id
      }, ["goal", "mode", "requestId"]),
      (controller, params) => controller.propose(params)
    ],
    [
      "run_simulated_trial",
      "Run simulated trial",
      "Run one synthetic alignment trial within the operator-approved experiment and remaining budget. Use an exact experimentId returned in this conversation and a stable requestId for this trial. Choose offsetMm within [-10,10], inspect the result and explain the next change. This invokes only the fixed synthetic fixture, never Node, cameras, robots or learned controllers. Approval must already exist; never fabricate or bypass it.",
      schema({ experimentId: id, requestId: id, offsetMm: { type: "number", minimum: -10, maximum: 10 } }, ["experimentId", "requestId", "offsetMm"]),
      (controller, params) => controller.trial(params)
    ],
    [
      "finish_local_experiment",
      "Finish local experiment",
      "Finish the current synthetic experiment and preserve its recorded result summary. Use the exact experimentId returned in this conversation. No physical outcome or readiness can be inferred.",
      schema({ experimentId: id }, ["experimentId"]),
      (controller, params) => controller.finish(params)
    ]
  ];
  return definitions.map(([name, label, description, parameters, invoke]) => defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_callId, params, signal) {
      if (signal?.aborted)
        throw new Error("The assistant request was cancelled before the synthetic trial request started");
      const keys = Object.keys(params || {});
      if (!params || typeof params !== "object" || Array.isArray(params) || keys.some((key) => !Object.hasOwn(parameters.properties, key)) || parameters.required.some((key) => !Object.hasOwn(params, key)))
        throw new TypeError("Experiment request has unsupported or missing fields");
      let controller, cancel;
      try {
        controller = getController();
        if (name === "run_simulated_trial" && signal) {
          cancel = () => {
            try {
              if (controller.snapshot().current?.id === params.experimentId)
                controller.stop({ experimentId: params.experimentId });
            } catch {}
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted)
            throw new Error("Assistant request cancelled");
        }
        const value = await invoke(controller, params);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          details: { displaySummary: `${label} · simulation only` }
        };
      } catch (error) {
        const known = experimentRequestFailure(error);
        throw Object.assign(new Error(known?.message || "The local experiment request could not complete. Inspect its current state before retrying; existing files were preserved."), { code: known?.code || "EXPERIMENT_UNAVAILABLE" });
      } finally {
        if (cancel)
          signal.removeEventListener("abort", cancel);
      }
    }
  }));
}
// ../harness-gripper-check/packages/cli/src/harness/workcell-controller.js
import { createHash as createHash5, randomUUID as randomUUID4 } from "node:crypto";

// ../harness-gripper-check/packages/cli/src/auth/redact.js
var SECRET_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "secretaccesskey",
  "authorization",
  "apikey",
  "token",
  "secret",
  "password"
]);
var TEXT_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+\/=\-]+/gi, "$1[REDACTED]"],
  [/\btinyedge_(?:sk|dk|mcp|mcp_refresh|mcp_code)_[A-Za-z0-9._~-]+\b/gi, "[REDACTED]"],
  [/([?&](?:access_?token|refresh_?token|token|api_?key|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]"],
  [/("(?:access_?token|refresh_?token|id_?token|client_?secret|secret_?access_?key|api_?key|token|secret|password)"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2"]
];
function redactText(value) {
  let result = String(value ?? "");
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function safeErrorMessage(error) {
  if (error instanceof Error)
    return redactText(error.message);
  return redactText(error);
}

// ../harness-gripper-check/packages/cli/src/harness/execution-controller.js
import { randomUUID as randomUUID3 } from "node:crypto";

// ../harness-gripper-check/packages/cli/src/physical/execution-contracts.js
import { createHash as createHash3 } from "node:crypto";
var EXECUTION_STATUS_VERSION = "physicalsystems-execution-status-v1";
var PHYSICAL_RUN_VERSION = "physicalsystems-run-v1";
var RUN_PHASES = Object.freeze(["PREPARING", "WAITING_FOR_APPROVAL", "READY", "DISPATCHING", "RUNNING", "VERIFYING", "VERIFIED_SUCCESS", "FAILED", "OUTCOME_UNKNOWN", "CANCELLED", "BLOCKED"]);
var STOP_PHASES = Object.freeze(["NOT_REQUESTED", "STOP_REQUESTED", "STOP_CONFIRMED", "STOP_UNCONFIRMED"]);
var numericTokens = new WeakMap;
function fail() {
  throw new TypeError("Execution response failed contract validation");
}
function check(value) {
  if (!value)
    fail();
}
function object(value) {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function executionFields(value, keys) {
  object(value);
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  return value;
}
function executionText(value, maximum = 256) {
  check(typeof value === "string" && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value));
  return value;
}
function executionId(value) {
  check(typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value));
  return value;
}
function executionRunId(value) {
  check(typeof value === "string" && /^run-[0-9a-f]{32}$/.test(value));
  return value;
}
function executionHash(value) {
  check(typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value));
  return value;
}
function integer(value) {
  check(Number.isSafeInteger(value) && value >= 0);
  return value;
}
function choice(value, values) {
  check(values.includes(value));
  return value;
}
function timestamp(value) {
  executionText(value, 64);
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
  return value;
}
function boundedArray(value, maximum = 256) {
  check(Array.isArray(value) && value.length <= maximum);
  return value;
}
function noAuthority(value) {
  check(value === false);
}
function mode(value) {
  return choice(value, ["simulation", "physical"]);
}
function unique(values) {
  check(new Set(values).size === values.length);
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function parseExecutionJson(raw) {
  return JSON.parse(raw, function(key, value, context) {
    if (typeof value === "number") {
      check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
      if (context?.source) {
        if (!numericTokens.has(this))
          numericTokens.set(this, new Map);
        numericTokens.get(this).set(key, context.source);
      }
    }
    return value;
  });
}
function compareKeys(a, b) {
  const left = [...a], right = [...b];
  for (let i = 0;i < Math.min(left.length, right.length); i += 1) {
    const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (delta)
      return delta;
  }
  return left.length - right.length;
}
function canonical(value, excluded, depth = 0, parent, key, maximumDepth = 16) {
  check(depth <= maximumDepth);
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
    if (Number.isInteger(value))
      return JSON.stringify(value);
    return numericTokens.get(parent)?.get(String(key)) ?? JSON.stringify(value);
  }
  if (typeof value === "string") {
    check(value.length <= 65536 && value.isWellFormed());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    boundedArray(value, 4096);
    return `[${value.map((item, index) => canonical(item, null, depth + 1, value, index, maximumDepth)).join(",")}]`;
  }
  object(value);
  check(Object.keys(value).length <= 512);
  return `{${Object.keys(value).filter((name) => name !== excluded).sort(compareKeys).map((name) => {
    check(name.length <= 256 && name.isWellFormed());
    return `${JSON.stringify(name)}:${canonical(value[name], null, depth + 1, value, name, maximumDepth)}`;
  }).join(",")}}`;
}
function executionDigest(value, excluded = null) {
  return `sha256:${createHash3("sha256").update(canonical(value, excluded, 0, undefined, undefined, 20), "utf8").digest("hex")}`;
}
function sealed(value, field) {
  check(executionHash(value[field]) === executionDigest(value, field));
}
function jsonObject(value) {
  object(value);
  check(Buffer.byteLength(canonical(value, null)) <= 512 * 1024);
  return value;
}
function normalizeExecutionStatus(value) {
  executionFields(value, ["contractVersion", "availability", "mode", "configurations", "reason", "physicalExecutionAuthorized"]);
  check(value.contractVersion === EXECUTION_STATUS_VERSION);
  choice(value.availability, ["available", "unavailable"]);
  if (value.mode !== null)
    mode(value.mode);
  if (value.reason !== null)
    executionText(value.reason, 512);
  noAuthority(value.physicalExecutionAuthorized);
  boundedArray(value.configurations, 128).forEach((item) => {
    executionFields(item, ["configurationId", "displayName", "capabilityId", "implementationId", "configurationDigest", "implementationDigest", "mode"]);
    executionId(item.configurationId);
    executionText(item.displayName);
    executionId(item.capabilityId);
    executionId(item.implementationId);
    executionHash(item.configurationDigest);
    executionHash(item.implementationDigest);
    mode(item.mode);
    if (value.mode !== null)
      check(item.mode === value.mode);
  });
  unique(value.configurations.map((item) => item.configurationId));
  if (value.availability === "available")
    check(value.mode !== null);
  return freeze(value);
}
function normalizePhysicalRun(value) {
  executionFields(value, ["contractVersion", "runId", "revision", "runDigest", "phase", "stopStatus", "mode", "capabilityId", "implementationId", "implementationDigest", "configurationId", "configurationDigest", "routeReceiptDigest", "inputs", "snapshotDigest", "approval", "createdAt", "updatedAt", "events", "outcome", "physicalExecutionAuthorized"]);
  check(value.contractVersion === PHYSICAL_RUN_VERSION);
  executionRunId(value.runId);
  integer(value.revision);
  choice(value.phase, RUN_PHASES);
  choice(value.stopStatus, STOP_PHASES);
  mode(value.mode);
  for (const key of ["capabilityId", "implementationId", "configurationId"])
    executionId(value[key]);
  for (const key of ["implementationDigest", "configurationDigest", "routeReceiptDigest", "snapshotDigest"])
    executionHash(value[key]);
  jsonObject(value.inputs);
  executionFields(value.approval, ["digest", "expiresAt", "approvedAt"]);
  executionHash(value.approval.digest);
  timestamp(value.approval.expiresAt);
  if (value.approval.approvedAt !== null) {
    timestamp(value.approval.approvedAt);
    check(Date.parse(value.approval.approvedAt) <= Date.parse(value.approval.expiresAt));
  }
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  check(Date.parse(value.updatedAt) >= Date.parse(value.createdAt));
  let previousSequence = 0;
  boundedArray(value.events, 1024).forEach((event) => {
    executionFields(event, ["sequence", "type", "at", "detail"]);
    integer(event.sequence);
    check(event.sequence === previousSequence + 1);
    previousSequence = event.sequence;
    check(typeof event.type === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(event.type));
    timestamp(event.at);
    jsonObject(event.detail);
  });
  if (value.outcome !== null) {
    executionFields(value.outcome, ["status", "reason", "evidenceDigest"]);
    choice(value.outcome.status, ["VERIFIED_SUCCESS", "FAILED", "OUTCOME_UNKNOWN", "CANCELLED", "BLOCKED"]);
    executionText(value.outcome.reason, 512);
    if (value.outcome.evidenceDigest !== null)
      executionHash(value.outcome.evidenceDigest);
    check(value.outcome.status === value.phase);
  }
  if (["READY", "DISPATCHING", "RUNNING", "VERIFYING", "VERIFIED_SUCCESS"].includes(value.phase))
    check(value.approval.approvedAt !== null);
  if (value.phase === "WAITING_FOR_APPROVAL")
    check(value.approval.approvedAt === null);
  if (value.phase === "VERIFIED_SUCCESS")
    check(value.outcome?.status === "VERIFIED_SUCCESS" && value.outcome.evidenceDigest !== null);
  noAuthority(value.physicalExecutionAuthorized);
  sealed(value, "runDigest");
  return freeze(value);
}
function normalizePhysicalRunList(value) {
  executionFields(value, ["contractVersion", "runs", "physicalExecutionAuthorized"]);
  check(value.contractVersion === "physicalsystems-run-list-v1");
  noAuthority(value.physicalExecutionAuthorized);
  boundedArray(value.runs, 32).forEach(normalizePhysicalRun);
  unique(value.runs.map((item) => item.runId));
  return freeze(value);
}
function assertRunMatches(run, expected) {
  for (const key of ["runId", "mode", "capabilityId", "implementationId", "implementationDigest", "configurationId", "configurationDigest", "routeReceiptDigest", "snapshotDigest"]) {
    if (Object.hasOwn(expected, key))
      check(run[key] === expected[key]);
  }
  if (expected.inputs)
    check(canonical(JSON.parse(JSON.stringify(run.inputs))) === canonical(JSON.parse(JSON.stringify(expected.inputs))));
  if (expected.approval)
    check(run.approval.digest === expected.approval.digest && run.approval.expiresAt === expected.approval.expiresAt);
  if (expected.revision !== undefined) {
    check(run.revision >= expected.revision);
    if (run.revision === expected.revision)
      check(run.runDigest === expected.runDigest);
    check(run.events.length >= expected.events.length);
    expected.events.forEach((event, index) => check(canonical(run.events[index]) === canonical(event)));
  }
  return run;
}
function normalizePhysicalRunReceipt(value, expected = {}) {
  executionFields(value, ["contractVersion", "run", "snapshot", "receiptDigest", "physicalExecutionAuthorized"]);
  check(value.contractVersion === "physicalsystems-run-receipt-v1");
  noAuthority(value.physicalExecutionAuthorized);
  assertRunMatches(normalizePhysicalRun(value.run), expected);
  jsonObject(value.snapshot);
  check(Object.keys(value.snapshot).length > 0);
  check(executionDigest(value.snapshot) === value.run.snapshotDigest);
  sealed(value, "receiptDigest");
  return freeze(value);
}
function normalizeExecutionSnapshot(value, expectedDigest) {
  executionFields(value, ["contractVersion", "snapshotDigest", "snapshot", "physicalExecutionAuthorized"]);
  check(value.contractVersion === "physicalsystems-snapshot-v1");
  noAuthority(value.physicalExecutionAuthorized);
  check(executionHash(value.snapshotDigest) === executionHash(expectedDigest));
  jsonObject(value.snapshot);
  check(Object.keys(value.snapshot).length > 0);
  check(executionDigest(value.snapshot) === expectedDigest);
  return freeze(value);
}

// ../harness-gripper-check/packages/cli/src/physical/route-contracts.js
import { createHash as createHash4 } from "node:crypto";
var PHYSICAL_CAPABILITY_CATALOG_VERSION = "experimental-physical-capability-catalog-v1";
var PHYSICAL_ROUTE_REQUEST_VERSION = "experimental-physical-route-preview-request-v1";
var PHYSICAL_ROUTE_RECEIPT_VERSION = "experimental-physical-route-receipt-v1";
var RUNTIME_DECISION_VERSION = "tinyedge-runtime-physical-skill-route-decision-v1";
var RUNTIME_REQUEST_VERSION = "tinyedge-runtime-physical-skill-route-request-v1";
var SCALAR_TYPES = ["boolean", "integer", "number", "string", "identifier", "digest"];
var REQUEST_FIELDS = [
  "contractVersion",
  "capabilityId",
  "workcellId",
  "arguments",
  "expectedRegistryDigest",
  "expectedCandidateBindingDigest",
  "expectedCatalogDigest",
  "expectedWorkcellDigest"
];
function object2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
}
function exact(value, keys, label) {
  object2(value, label);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError(`${label} has unsupported or missing fields`);
  return value;
}
function text(value, label, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new TypeError(`${label} must be bounded printable text`);
  }
  return value;
}
function id2(value, label) {
  const result = text(value, label, 128);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(result))
    throw new TypeError(`${label} must be an identifier`);
  return result;
}
function routeDigest(value, label = "route digest") {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new TypeError(`${label} must be a sha256 digest`);
  return value;
}
function array(value, label, max = 512) {
  if (!Array.isArray(value) || value.length > max)
    throw new TypeError(`${label} must be a bounded array`);
  return value;
}
function distinct(items, key, label) {
  if (new Set(items.map((item) => item[key])).size !== items.length)
    throw new TypeError(`${label} must be distinct`);
  return items;
}
function choice2(value, options, label) {
  if (!options.includes(value))
    throw new TypeError(`${label} is unsupported`);
  return value;
}
function noAuthority2(value, label) {
  if (value !== false)
    throw new TypeError(`${label} cannot authorize physical execution`);
  return false;
}
function timestamp2(value, label) {
  text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new TypeError(`${label} must be a UTC timestamp`);
  return value;
}
function monotonicText(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new TypeError(`${label} must be decimal monotonic nanoseconds`);
  return value;
}
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value))
      frozen(child);
    Object.freeze(value);
  }
  return value;
}
function scalar(value, type, label) {
  if (type === "boolean") {
    if (typeof value !== "boolean")
      throw new TypeError(`${label} must be boolean`);
    return value;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1000000000000 || type === "integer" && (!Number.isSafeInteger(value) || Math.abs(value) > 1000000000000)) {
      throw new TypeError(`${label} must be a finite ${type}`);
    }
    return value;
  }
  if (type === "identifier")
    return id2(value, label);
  if (type === "digest")
    return routeDigest(value, label);
  return text(value, label);
}
function inputField(value) {
  const field = exact(value, ["name", "value_type", "required", "unit", "minimum", "maximum"], "physical capability input");
  const type = choice2(field.value_type, SCALAR_TYPES, "physical capability input type");
  if (field.required !== true)
    throw new TypeError("Physical capability v1 inputs must be required");
  for (const bound of [field.minimum, field.maximum]) {
    if (bound !== null && (typeof bound !== "number" || !Number.isFinite(bound) || Math.abs(bound) > 1000000000000))
      throw new TypeError("Physical capability bounds must be finite or null");
  }
  if (["number", "integer"].includes(type)) {
    if (field.unit === null || field.minimum === null || field.maximum === null || field.minimum > field.maximum)
      throw new TypeError("Physical capability numeric unit and bounds are required");
    if (type === "integer" && (!Number.isInteger(field.minimum) || !Number.isInteger(field.maximum)))
      throw new TypeError("Physical capability integer bounds must be integral");
  } else if (field.unit !== null || field.minimum !== null || field.maximum !== null) {
    throw new TypeError("Physical capability nonnumeric input cannot have numeric bounds");
  }
  return {
    name: id2(field.name, "physical capability input name"),
    value_type: type,
    required: true,
    unit: field.unit === null ? null : id2(field.unit, "physical capability input unit"),
    minimum: field.minimum,
    maximum: field.maximum
  };
}
function requirement(value) {
  const item = exact(value, ["requirement_id", "requirement_digest", "maximum_age_ns"], "physical requirement");
  if (!Number.isSafeInteger(item.maximum_age_ns) || item.maximum_age_ns < 1 || item.maximum_age_ns > 300000000000)
    throw new TypeError("Physical requirement freshness must be a bounded integer");
  return {
    requirement_id: id2(item.requirement_id, "physical requirement ID"),
    requirement_digest: routeDigest(item.requirement_digest, "physical requirement digest"),
    maximum_age_ns: item.maximum_age_ns
  };
}
function normalizePhysicalCapabilityCatalog(value) {
  const catalog = exact(value, ["contractVersion", "registryDigest", "currentCandidateBindingDigest", "capabilities", "workcells", "runtimeVersion", "physicalExecutionAuthorized"], "physical capability catalog");
  if (catalog.contractVersion !== PHYSICAL_CAPABILITY_CATALOG_VERSION)
    throw new TypeError("Unsupported physical capability catalog version");
  if (catalog.runtimeVersion !== "0.2.0")
    throw new TypeError("Unsupported capability routing Runtime version");
  const capabilities = distinct(array(catalog.capabilities, "physical capabilities").map((entry) => {
    const capability = exact(entry, ["capabilityId", "displayName", "definitionDigest", "inputFields", "preconditions", "availableForRouting", "reasonCodes"], "physical capability");
    if (typeof capability.availableForRouting !== "boolean")
      throw new TypeError("Physical capability routing availability must be boolean");
    return {
      capabilityId: id2(capability.capabilityId, "physical capability ID"),
      displayName: text(capability.displayName, "physical capability display name", 256),
      definitionDigest: routeDigest(capability.definitionDigest, "physical capability definition digest"),
      inputFields: distinct(array(capability.inputFields, "physical capability inputs", 128).map(inputField), "name", "Physical capability input names"),
      preconditions: distinct(array(capability.preconditions, "physical capability preconditions", 64).map(requirement), "requirement_id", "Physical preconditions"),
      availableForRouting: capability.availableForRouting,
      reasonCodes: array(capability.reasonCodes, "physical capability reasons", 64).map((code) => id2(code, "physical capability reason"))
    };
  }), "capabilityId", "Physical capability IDs");
  const workcells = distinct(array(catalog.workcells, "physical workcells", 64).map((entry) => {
    const workcell = exact(entry, ["workcellId", "workcellDigest", "catalogDigest"], "physical workcell");
    return {
      workcellId: id2(workcell.workcellId, "physical workcell ID"),
      workcellDigest: routeDigest(workcell.workcellDigest, "physical workcell digest"),
      catalogDigest: workcell.catalogDigest === null ? null : routeDigest(workcell.catalogDigest, "workcell catalog digest")
    };
  }), "workcellId", "Physical workcell IDs");
  return frozen({
    contractVersion: PHYSICAL_CAPABILITY_CATALOG_VERSION,
    runtimeVersion: catalog.runtimeVersion,
    registryDigest: routeDigest(catalog.registryDigest, "physical registry digest"),
    currentCandidateBindingDigest: routeDigest(catalog.currentCandidateBindingDigest, "physical candidate binding digest"),
    capabilities,
    workcells,
    physicalExecutionAuthorized: noAuthority2(catalog.physicalExecutionAuthorized, "Capability catalog")
  });
}
function normalizePhysicalRouteRequest(value) {
  const request = object2(value, "physical route preview request");
  if (Object.keys(request).length !== REQUEST_FIELDS.length || REQUEST_FIELDS.some((key) => !Object.hasOwn(request, key))) {
    throw new TypeError("Physical route preview request has unsupported or missing fields");
  }
  if (request.contractVersion !== PHYSICAL_ROUTE_REQUEST_VERSION)
    throw new TypeError("Unsupported physical route preview request version");
  const argumentsList = distinct(array(request.arguments, "physical capability arguments", 128).map((entry) => {
    const argument = object2(entry, "physical capability argument");
    if (Object.keys(argument).length !== 3 || !["name", "value_type", "value"].every((key) => Object.hasOwn(argument, key)))
      throw new TypeError("Physical capability argument has unsupported fields");
    const type = choice2(argument.value_type, SCALAR_TYPES, "physical capability argument type");
    return { name: id2(argument.name, "physical capability argument name"), value_type: type, value: scalar(argument.value, type, "physical capability argument value") };
  }), "name", "Physical capability argument names");
  if (argumentsList.some((argument, index) => index > 0 && argumentsList[index - 1].name > argument.name))
    throw new TypeError("Physical capability arguments must be sorted by name");
  return frozen({
    contractVersion: PHYSICAL_ROUTE_REQUEST_VERSION,
    capabilityId: id2(request.capabilityId, "physical capability ID"),
    workcellId: id2(request.workcellId, "physical workcell ID"),
    arguments: argumentsList,
    ...Object.fromEntries(REQUEST_FIELDS.filter((key) => key.startsWith("expected")).map((key) => [key, routeDigest(request[key], key)]))
  });
}
function target(value) {
  const item = exact(value, ["kind", "digest"], "capability implementation execution target");
  return { kind: id2(item.kind, "execution target kind"), digest: routeDigest(item.digest, "execution target digest") };
}
function decision(value) {
  const result = exact(value, ["contract_version", "request_id", "request_digest", "catalog_digest", "policy_digest", "state_digest", "invocation_digest", "decision_status", "selected_implementation_id", "selected_implementation_digest", "selected_execution_target", "request_rejection_codes", "candidates", "physical_execution_authorized", "decision_digest"], "physical route decision");
  if (result.contract_version !== RUNTIME_DECISION_VERSION)
    throw new TypeError("Unsupported Runtime route decision version");
  noAuthority2(result.physical_execution_authorized, "Route decision");
  const status = choice2(result.decision_status, ["selected", "no_match"], "physical route status");
  const candidates = distinct(array(result.candidates, "capability implementation candidates").map((entry) => {
    const candidate = exact(entry, ["implementation_id", "implementation_digest", "mechanism", "provider", "execution_target", "status", "rejection_codes"], "capability implementation candidate");
    const candidateStatus = choice2(candidate.status, ["selected", "eligible_not_selected", "rejected"], "capability implementation status");
    const rejectionCodes = array(candidate.rejection_codes, "capability implementation rejection codes", 64).map((code) => id2(code, "route rejection code"));
    if (candidateStatus === "rejected" !== rejectionCodes.length > 0)
      throw new TypeError("Capability implementation reasons contradict its status");
    return {
      implementation_id: id2(candidate.implementation_id, "capability implementation ID"),
      implementation_digest: routeDigest(candidate.implementation_digest, "capability implementation digest"),
      mechanism: id2(candidate.mechanism, "capability implementation mechanism"),
      provider: id2(candidate.provider, "capability implementation provider"),
      execution_target: target(candidate.execution_target),
      status: candidateStatus,
      rejection_codes: rejectionCodes
    };
  }), "implementation_id", "Capability implementation IDs");
  const requestCodes = array(result.request_rejection_codes, "request rejection codes", 64).map((code) => id2(code, "request rejection code"));
  const { decision_digest: suppliedDigest, ...sealedDecision } = result;
  const expectedDigest = `sha256:${createHash4("sha256").update(canonicalJson(sealedDecision)).digest("hex")}`;
  if (routeDigest(suppliedDigest, "decision_digest") !== expectedDigest)
    throw new TypeError("Physical route decision digest does not match its content");
  const selected = candidates.filter((candidate) => candidate.status === "selected");
  if (status === "selected") {
    if (selected.length !== 1 || requestCodes.length || selected[0].implementation_id !== result.selected_implementation_id || selected[0].implementation_digest !== result.selected_implementation_digest || JSON.stringify(selected[0].execution_target) !== JSON.stringify(target(result.selected_execution_target))) {
      throw new TypeError("Physical route selection is inconsistent");
    }
  } else if (selected.length || result.selected_implementation_id !== null || result.selected_implementation_digest !== null || result.selected_execution_target !== null || !requestCodes.length && candidates.some((candidate) => candidate.status !== "rejected")) {
    throw new TypeError("No-route decision cannot contain an eligible selection");
  }
  return {
    contract_version: RUNTIME_DECISION_VERSION,
    request_id: id2(result.request_id, "Runtime route request ID"),
    ...Object.fromEntries(["request_digest", "catalog_digest", "policy_digest", "state_digest", "invocation_digest", "decision_digest"].map((key) => [key, routeDigest(result[key], key)])),
    decision_status: status,
    selected_implementation_id: selected[0]?.implementation_id ?? null,
    selected_implementation_digest: selected[0]?.implementation_digest ?? null,
    selected_execution_target: selected[0]?.execution_target ?? null,
    request_rejection_codes: requestCodes,
    candidates,
    physical_execution_authorized: false
  };
}
function normalizePhysicalRouteReceipt(value, expectedRequest = null) {
  const receipt = exact(value, ["contractVersion", "evaluatedAt", "observedAt", "capabilityId", "workcellId", "request", "policyVersion", "evaluationMonotonicNs", "assessmentTimestamps", "implementations", "registrySnapshotDigest", "runtimeVersion", "hostEvidenceDigest", "hostEvidence", "runtimeRequest", "runtimeCatalog", "decision", "physicalExecutionAuthorized", "receiptDigest"], "physical route receipt");
  if (receipt.contractVersion !== PHYSICAL_ROUTE_RECEIPT_VERSION)
    throw new TypeError("Unsupported physical route receipt version");
  if (receipt.runtimeVersion !== "0.2.0")
    throw new TypeError("Unsupported capability routing Runtime version");
  object2(receipt.hostEvidence, "host evidence");
  object2(receipt.runtimeRequest, "stored Runtime request");
  object2(receipt.runtimeCatalog, "stored Runtime catalog");
  noAuthority2(receipt.physicalExecutionAuthorized, "Route receipt");
  const request = normalizePhysicalRouteRequest(receipt.request);
  if (expectedRequest !== null && JSON.stringify(request) !== JSON.stringify(normalizePhysicalRouteRequest(expectedRequest)))
    throw new TypeError("Route receipt does not match the requested capability invocation");
  const routeDecision = decision(receipt.decision);
  if (receipt.capabilityId !== request.capabilityId || receipt.workcellId !== request.workcellId || routeDecision.catalog_digest !== request.expectedCatalogDigest)
    throw new TypeError("Route receipt context does not match its request");
  const storedRequest = receipt.runtimeRequest;
  if (storedRequest.contract_version !== RUNTIME_REQUEST_VERSION || storedRequest.skill_id !== request.capabilityId || storedRequest.workcell_id !== request.workcellId || storedRequest.workcell_digest !== request.expectedWorkcellDigest || storedRequest.manifest_digest !== request.expectedWorkcellDigest || storedRequest.catalog_digest !== request.expectedCatalogDigest || storedRequest.request_id !== routeDecision.request_id || storedRequest.request_digest !== routeDecision.request_digest || storedRequest.invocation_digest !== routeDecision.invocation_digest || storedRequest.state_digest !== routeDecision.state_digest || canonicalJson(storedRequest.arguments) !== canonicalJson(request.arguments)) {
    throw new TypeError("Route decision does not match its stored typed invocation");
  }
  const storedCatalog = receipt.runtimeCatalog;
  if (storedCatalog.catalog_digest !== request.expectedCatalogDigest || storedCatalog.workcell_id !== request.workcellId || storedCatalog.workcell_digest !== request.expectedWorkcellDigest)
    throw new TypeError("Stored route catalog context does not match");
  const implementations = distinct(array(receipt.implementations, "receipt capability implementations").map((entry) => {
    exact(entry, ["implementationId", "qualificationStatus"], "capability implementation metadata");
    return {
      implementationId: id2(entry.implementationId, "receipt capability implementation ID"),
      qualificationStatus: choice2(entry.qualificationStatus, ["qualified", "demo_qualified", "provisional", "blocked"], "capability implementation qualification")
    };
  }), "implementationId", "Receipt capability implementation IDs");
  if (implementations.length !== routeDecision.candidates.length || implementations.some((entry) => !routeDecision.candidates.some((candidate) => candidate.implementation_id === entry.implementationId)))
    throw new TypeError("Receipt qualification metadata does not match its candidates");
  const catalogImplementations = array(storedCatalog.implementations, "stored capability implementations");
  for (const candidate of routeDecision.candidates) {
    const metadata = implementations.find((entry) => entry.implementationId === candidate.implementation_id);
    const implementation = catalogImplementations.find((entry) => entry.implementation_id === candidate.implementation_id);
    if (!implementation || implementation.skill_id !== request.capabilityId || implementation.implementation_digest !== candidate.implementation_digest || implementation.qualification_status !== metadata.qualificationStatus || implementation.mechanism !== candidate.mechanism || implementation.provider !== candidate.provider || canonicalJson(implementation.execution_target) !== canonicalJson(candidate.execution_target))
      throw new TypeError("Capability implementation metadata does not match its stored catalog");
  }
  const policy = exact(receipt.policyVersion, ["contractVersion", "policyId", "policyDigest"], "route policy version");
  if (policy.contractVersion !== RUNTIME_REQUEST_VERSION)
    throw new TypeError("Unsupported route policy contract version");
  if (policy.policyDigest !== routeDecision.policy_digest)
    throw new TypeError("Route policy metadata does not match its decision");
  if (storedRequest.policy?.policy_digest !== policy.policyDigest || storedRequest.policy?.policy_id !== policy.policyId)
    throw new TypeError("Route policy metadata does not match its stored request");
  return frozen({
    contractVersion: PHYSICAL_ROUTE_RECEIPT_VERSION,
    runtimeVersion: receipt.runtimeVersion,
    registrySnapshotDigest: routeDigest(receipt.registrySnapshotDigest, "registry snapshot digest"),
    hostEvidenceDigest: routeDigest(receipt.hostEvidenceDigest, "host evidence digest"),
    receiptDigest: routeDigest(receipt.receiptDigest, "physical route receipt digest"),
    evaluatedAt: timestamp2(receipt.evaluatedAt, "physical route evaluation time"),
    observedAt: timestamp2(receipt.observedAt, "physical observation time"),
    evaluationMonotonicNs: monotonicText(receipt.evaluationMonotonicNs, "evaluation time"),
    assessmentTimestamps: distinct(array(receipt.assessmentTimestamps, "assessment timestamps", 512).map((entry) => {
      exact(entry, ["preconditionId", "observedMonotonicNs"], "assessment timestamp");
      return {
        preconditionId: id2(entry.preconditionId, "assessment requirement ID"),
        observedMonotonicNs: entry.observedMonotonicNs === null ? null : monotonicText(entry.observedMonotonicNs, "assessment observation time")
      };
    }), "preconditionId", "Assessment timestamp IDs"),
    policyVersion: {
      contractVersion: text(policy.contractVersion, "physical route policy contract version", 128),
      policyId: id2(policy.policyId, "physical route policy ID"),
      policyDigest: routeDigest(policy.policyDigest, "physical route policy digest")
    },
    capabilityId: request.capabilityId,
    workcellId: request.workcellId,
    request,
    decision: routeDecision,
    implementations,
    physicalExecutionAuthorized: false
  });
}
function physicalRouteReceiptPath(digest2) {
  return `/v2/physical/routes/${routeDigest(digest2).slice("sha256:".length)}`;
}

// ../harness-gripper-check/packages/cli/src/physical/node-client.js
var DEFAULT_PHYSICAL_NODE_URL = "http://127.0.0.1:8876";
var DEFAULT_TIMEOUT_MS = 5000;
var MAX_RESPONSE_BYTES = 256 * 1024;
var MAX_ROUTE_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_INTENT_CHARACTERS = 500;
var LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
var PHYSICAL_NODE_STATE_VERSION = "experimental-physical-node-state-v1";
var PHYSICAL_CANDIDATE_SNAPSHOT_VERSION = "experimental-physical-candidates-v1";
var PHYSICAL_NODE_INTENT_REQUEST_VERSION = "experimental-physical-node-intent-request-v1";
var PHYSICAL_NODE_INTENT_VERSION = "experimental-physical-node-intent-response-v1";
function object3(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function text2(value, label, maximum = 512) {
  if (typeof value !== "string" || !value || value.length > maximum || !value.trim()) {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}
function bool(value, label) {
  if (typeof value !== "boolean")
    throw new Error(`${label} must be boolean`);
  return value;
}
function array2(value, label, maximum = 64) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}
function identifier2(value, label) {
  const result = text2(value, label, 128);
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(result)) {
    throw new Error(`${label} must be a lowercase identifier`);
  }
  return result;
}
function optionalIdentifier(value, label) {
  if (value === null)
    return null;
  return identifier2(value, label);
}
function clone2(value) {
  return JSON.parse(JSON.stringify(value));
}
function digest2(value, label) {
  const result = text2(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(result))
    throw new Error(`${label} must be a sha256 digest`);
  return result;
}
function oneOf(value, allowed, label) {
  const result = text2(value, label, 64);
  if (!allowed.includes(result))
    throw new Error(`${label} is unsupported`);
  return result;
}
function normalizePhysicalNodeUrl(value = DEFAULT_PHYSICAL_NODE_URL) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError("Physical node URL must be an absolute loopback HTTP URL");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TypeError("Physical node must use loopback HTTP");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Physical node URL cannot contain credentials, query, or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new TypeError("Physical node URL must be an origin without a path");
  }
  return parsed.origin;
}
function normalizeDevice(value, index) {
  const device = object3(value, `physical discovery device ${index}`);
  const roles = array2(device.roles, `physical discovery device ${index}.roles`, 8).map((role, roleIndex) => identifier2(role, `physical discovery device ${index}.roles[${roleIndex}]`));
  const capabilities = array2(device.capabilities, `physical discovery device ${index}.capabilities`).map((capability, capabilityIndex) => identifier2(capability, `physical discovery device ${index}.capabilities[${capabilityIndex}]`));
  const result = {
    deviceId: identifier2(device.deviceId, `physical discovery device ${index}.deviceId`),
    kind: identifier2(device.kind, `physical discovery device ${index}.kind`),
    roles,
    capabilities,
    configured: bool(device.configured, `physical discovery device ${index}.configured`),
    detected: bool(device.detected, `physical discovery device ${index}.detected`),
    driverReady: bool(device.driverReady, `physical discovery device ${index}.driverReady`),
    calibrationReady: bool(device.calibrationReady, `physical discovery device ${index}.calibrationReady`),
    ready: bool(device.ready, `physical discovery device ${index}.ready`)
  };
  if (!result.configured)
    throw new Error(`physical discovery device ${index} must be enrolled`);
  if (result.ready !== (result.detected && result.driverReady && result.calibrationReady)) {
    throw new Error(`physical discovery device ${index} readiness is inconsistent`);
  }
  return result;
}
function normalizeSummary(value, devices) {
  const summary2 = object3(value, "physical discovery summary");
  const result = {};
  for (const name of ["configured", "detected", "driverReady", "calibrationReady", "ready"]) {
    if (!Number.isInteger(summary2[name]) || summary2[name] < 0 || summary2[name] > devices.length) {
      throw new Error(`physical discovery summary.${name} is invalid`);
    }
    result[name] = summary2[name];
  }
  result.allReady = bool(summary2.allReady, "physical discovery summary.allReady");
  const expected = {
    configured: devices.length,
    detected: devices.filter((device) => device.detected).length,
    driverReady: devices.filter((device) => device.driverReady).length,
    calibrationReady: devices.filter((device) => device.calibrationReady).length,
    ready: devices.filter((device) => device.ready).length
  };
  if (Object.keys(expected).some((name) => result[name] !== expected[name])) {
    throw new Error("physical discovery summary does not match its devices");
  }
  if (result.allReady !== (devices.length > 0 && result.ready === devices.length)) {
    throw new Error("physical discovery allReady does not match its devices");
  }
  return result;
}
function normalizePhysicalNodeState(value) {
  const state = object3(value, "physical node state");
  if (state.contractVersion !== PHYSICAL_NODE_STATE_VERSION) {
    throw new Error(`physical node state must use ${PHYSICAL_NODE_STATE_VERSION}`);
  }
  const system = object3(state.system, "physical node system");
  const discovery = object3(state.discovery, "physical node discovery");
  const devices = array2(discovery.devices, "physical node discovery.devices", 16).map(normalizeDevice);
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) {
    throw new Error("physical discovery device IDs must be distinct");
  }
  const normalized = {
    contractVersion: PHYSICAL_NODE_STATE_VERSION,
    nodeName: text2(state.nodeName, "physical node name", 128),
    system: {
      systemId: identifier2(system.systemId, "physical node system.systemId"),
      displayName: text2(system.displayName, "physical node system.displayName", 256),
      workcellId: identifier2(system.workcellId, "physical node system.workcellId")
    },
    discovery: {
      schemaVersion: text2(discovery.schemaVersion, "physical node discovery.schemaVersion", 128),
      enrollmentId: identifier2(discovery.enrollmentId, "physical node discovery.enrollmentId"),
      observedAt: text2(discovery.observedAt, "physical node discovery.observedAt", 64),
      snapshotDigest: digest2(discovery.snapshotDigest, "physical node discovery.snapshotDigest"),
      devices,
      summary: normalizeSummary(discovery.summary, devices)
    },
    discoveryBindingDigest: digest2(state.discoveryBindingDigest, "physical node state.discoveryBindingDigest"),
    physicalExecutionAuthorized: bool(state.physicalExecutionAuthorized, "physical node state.physicalExecutionAuthorized")
  };
  if (normalized.physicalExecutionAuthorized) {
    throw new Error("physical node discovery cannot authorize execution");
  }
  return Object.freeze(normalized);
}
var ADAPTER_STATUSES = Object.freeze(["unavailable", "available", "setup-required"]);
var PROVIDER_STATUSES = Object.freeze(["ok", "degraded", "unavailable", "error"]);
function normalizeCandidate(value, index) {
  const candidate = object3(value, `physical candidate ${index}`);
  const adapter = object3(candidate.adapter, `physical candidate ${index}.adapter`);
  const adapterStatus = oneOf(adapter.status, ADAPTER_STATUSES, `physical candidate ${index}.adapter.status`);
  const adapterId = optionalIdentifier(adapter.adapterId, `physical candidate ${index}.adapter.adapterId`);
  if (adapterStatus !== "unavailable" && adapterId === null) {
    throw new Error(`physical candidate ${index} available adapter requires an ID`);
  }
  if (adapter.detail !== null) {
    text2(adapter.detail, `physical candidate ${index}.adapter.detail`, 512);
  }
  if (!bool(candidate.detected, `physical candidate ${index}.detected`)) {
    throw new Error(`physical candidate ${index} must be observed`);
  }
  const commissioned = bool(candidate.commissioned, `physical candidate ${index}.commissioned`);
  const ready = bool(candidate.ready, `physical candidate ${index}.ready`);
  if (ready && !commissioned) {
    throw new Error(`physical candidate ${index} cannot be ready before commissioning`);
  }
  if (ready && adapterStatus !== "available") {
    throw new Error(`physical candidate ${index} ready state requires an available adapter`);
  }
  const capabilities = array2(candidate.capabilities, `physical candidate ${index}.capabilities`, 128).map((capability, capabilityIndex) => identifier2(capability, `physical candidate ${index}.capabilities[${capabilityIndex}]`));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`physical candidate ${index}.capabilities must be distinct`);
  }
  const properties = object3(candidate.properties, `physical candidate ${index}.properties`);
  if (Object.keys(properties).length > 32) {
    throw new Error(`physical candidate ${index}.properties must be bounded`);
  }
  for (const [key, value2] of Object.entries(properties)) {
    identifier2(key, `physical candidate ${index}.properties key`);
    text2(value2, `physical candidate ${index}.properties.${key}`, 1024);
  }
  const providerId = identifier2(candidate.providerId, `physical candidate ${index}.providerId`);
  text2(candidate.observedIdentity, `physical candidate ${index}.observedIdentity`, 1024);
  oneOf(candidate.identityStability, ["stable", "network", "session"], `physical candidate ${index}.identityStability`);
  const readiness = ready ? "ready" : adapterStatus === "unavailable" ? "detected" : adapterStatus === "setup-required" ? "setup-required" : commissioned ? "commissioned" : "adapter-available";
  return {
    deviceId: identifier2(candidate.candidateId, `physical candidate ${index}.candidateId`),
    displayName: text2(candidate.displayName, `physical candidate ${index}.displayName`, 512),
    kind: identifier2(candidate.deviceClass, `physical candidate ${index}.deviceClass`),
    transport: identifier2(candidate.transport, `physical candidate ${index}.transport`),
    presence: "observed",
    roles: [],
    capabilities,
    adapterId,
    adapterStatus,
    commissioningStatus: commissioned ? "commissioned" : "not-commissioned",
    readiness,
    providerId,
    configured: commissioned,
    detected: true,
    driverReady: adapterStatus === "available",
    calibrationReady: commissioned,
    ready
  };
}
function candidateSummary(devices) {
  const summary2 = {
    configured: devices.filter((device) => device.configured).length,
    detected: devices.length,
    driverReady: devices.filter((device) => device.driverReady).length,
    calibrationReady: devices.filter((device) => device.calibrationReady).length,
    ready: devices.filter((device) => device.ready).length
  };
  return {
    ...summary2,
    allReady: devices.length > 0 && summary2.ready === devices.length
  };
}
function normalizePhysicalCandidateSnapshot(value) {
  const snapshot = object3(value, "physical candidate snapshot");
  if (snapshot.contractVersion !== PHYSICAL_CANDIDATE_SNAPSHOT_VERSION) {
    throw new Error(`physical candidate snapshot must use ${PHYSICAL_CANDIDATE_SNAPSHOT_VERSION}`);
  }
  const nodeName = text2(snapshot.nodeName, "physical candidate snapshot.nodeName", 512);
  const devices = array2(snapshot.candidates, "physical candidate snapshot.candidates", 512).map(normalizeCandidate);
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) {
    throw new Error("physical candidate IDs must be distinct");
  }
  const providers = array2(snapshot.providers, "physical candidate snapshot.providers", 64).map((value2, index) => {
    const provider = object3(value2, `physical candidate provider ${index}`);
    const providerId = identifier2(provider.providerId, `physical candidate provider ${index}.providerId`);
    const status = oneOf(provider.status, PROVIDER_STATUSES, `physical candidate provider ${index}.status`);
    if (!Number.isInteger(provider.candidateCount) || provider.candidateCount < 0 || provider.candidateCount > devices.length) {
      throw new Error(`physical candidate provider ${index}.candidateCount is invalid`);
    }
    if (provider.detail !== null) {
      text2(provider.detail, `physical candidate provider ${index}.detail`, 512);
    }
    return { providerId, status, candidateCount: provider.candidateCount };
  });
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) {
    throw new Error("physical candidate provider IDs must be distinct");
  }
  const providerCounts = new Map(providers.map((provider) => [provider.providerId, 0]));
  for (const device of devices) {
    if (!providerCounts.has(device.providerId)) {
      throw new Error("physical candidate references an unknown provider");
    }
    providerCounts.set(device.providerId, providerCounts.get(device.providerId) + 1);
  }
  if (providers.some((provider) => providerCounts.get(provider.providerId) !== provider.candidateCount)) {
    throw new Error("physical candidate provider counts do not match candidates");
  }
  const rawSummary = object3(snapshot.summary, "physical candidate snapshot.summary");
  const expectedRawSummary = {
    detected: devices.length,
    adapterAvailable: devices.filter((device) => device.adapterStatus === "available").length,
    setupRequired: devices.filter((device) => device.adapterStatus === "setup-required").length,
    commissioned: devices.filter((device) => device.configured).length,
    ready: devices.filter((device) => device.ready).length
  };
  for (const [name, expected] of Object.entries(expectedRawSummary)) {
    if (rawSummary[name] !== expected) {
      throw new Error(`physical candidate snapshot.summary.${name} does not match candidates`);
    }
  }
  const publicDevices = devices.map(({ providerId: _providerId, ...device }) => device);
  const snapshotDigest = digest2(snapshot.snapshotDigest, "physical candidate snapshot.snapshotDigest");
  const normalized = {
    contractVersion: PHYSICAL_CANDIDATE_SNAPSHOT_VERSION,
    nodeName,
    system: {
      systemId: null,
      displayName: nodeName,
      workcellId: null
    },
    discovery: {
      schemaVersion: PHYSICAL_CANDIDATE_SNAPSHOT_VERSION,
      enrollmentId: null,
      mode: "candidates",
      observedAt: text2(snapshot.observedAt, "physical candidate snapshot.observedAt", 64),
      snapshotDigest,
      devices: publicDevices,
      summary: candidateSummary(publicDevices),
      providerErrors: providers.filter((provider) => provider.status !== "ok").map((provider) => ({ status: provider.status }))
    },
    discoveryBindingDigest: snapshotDigest,
    physicalExecutionAuthorized: bool(snapshot.physicalExecutionAuthorized, "physical candidate snapshot.physicalExecutionAuthorized")
  };
  if (normalized.physicalExecutionAuthorized) {
    throw new Error("physical candidate discovery cannot authorize execution");
  }
  return Object.freeze(normalized);
}
function normalizeInterpretation(value) {
  const interpretation = object3(value, "physical intent interpretation");
  const status = text2(interpretation.status, "physical intent status", 64);
  if (!["ready", "needs-clarification", "unsupported"].includes(status)) {
    throw new Error("physical intent status is unsupported");
  }
  const normalized = clone2(interpretation);
  normalized.status = status;
  normalized.interpretationDigest = digest2(interpretation.interpretationDigest, "physical intent interpretationDigest");
  const grounding = object3(interpretation.grounding, "physical intent grounding");
  normalized.grounding = {
    ...clone2(grounding),
    objectId: optionalIdentifier(grounding.objectId, "physical intent grounding.objectId"),
    sourceStationId: optionalIdentifier(grounding.sourceStationId, "physical intent grounding.sourceStationId"),
    destinationStationId: optionalIdentifier(grounding.destinationStationId, "physical intent grounding.destinationStationId")
  };
  if (interpretation.workflowIntent === null) {
    normalized.workflowIntent = null;
  } else {
    const workflowIntent = object3(interpretation.workflowIntent, "physical intent workflowIntent");
    if (!Object.keys(workflowIntent).length) {
      throw new Error("physical intent workflowIntent must not be empty");
    }
    normalized.workflowIntent = clone2(workflowIntent);
  }
  normalized.requiredOperations = array2(interpretation.requiredOperations, "physical intent requiredOperations", 8).map((value2, index) => {
    const operation = object3(value2, `physical intent requiredOperations[${index}]`);
    return {
      ...clone2(operation),
      deviceRole: identifier2(operation.deviceRole, `physical intent requiredOperations[${index}].deviceRole`),
      operationId: identifier2(operation.operationId, `physical intent requiredOperations[${index}].operationId`),
      effect: oneOf(operation.effect, ["read-only", "actuating"], `physical intent requiredOperations[${index}].effect`)
    };
  });
  const operationKeys = normalized.requiredOperations.map((operation) => `${operation.deviceRole}\x00${operation.operationId}`);
  if (new Set(operationKeys).size !== operationKeys.length) {
    throw new Error("physical intent requiredOperations must be distinct");
  }
  normalized.physicalExecutionAuthorized = bool(interpretation.physicalExecutionAuthorized, "physical intent physicalExecutionAuthorized");
  if (normalized.physicalExecutionAuthorized) {
    throw new Error("physical intent planning cannot authorize execution");
  }
  normalized.gaps = array2(interpretation.gaps, "physical intent gaps", 64).map((gap, index) => {
    const item = object3(gap, `physical intent gap ${index}`);
    const operationIds = array2(item.operationIds, `physical intent gap ${index}.operationIds`, 8).map((operationId, operationIndex) => identifier2(operationId, `physical intent gap ${index}.operationIds[${operationIndex}]`));
    if (new Set(operationIds).size !== operationIds.length) {
      throw new Error(`physical intent gap ${index}.operationIds must be distinct`);
    }
    return {
      ...clone2(item),
      gapId: identifier2(item.gapId, `physical intent gap ${index}.gapId`),
      kind: identifier2(item.kind, `physical intent gap ${index}.kind`),
      deviceId: optionalIdentifier(item.deviceId, `physical intent gap ${index}.deviceId`),
      operationIds,
      detail: text2(item.detail, `physical intent gap ${index}.detail`, 512)
    };
  });
  normalized.questions = array2(interpretation.questions, "physical intent questions", 16).map((question, index) => text2(question, `physical intent question ${index}`, 500));
  if (status === "ready") {
    if (!normalized.workflowIntent) {
      throw new Error("ready physical intent must contain a workflow intent");
    }
    if (normalized.gaps.length || normalized.questions.length) {
      throw new Error("ready physical intent cannot contain unresolved gaps or questions");
    }
  } else if (normalized.workflowIntent !== null) {
    throw new Error("only a ready physical intent may contain a workflow intent");
  }
  return normalized;
}
function normalizePhysicalIntentResponse(value) {
  const response = object3(value, "physical intent response");
  if (response.contractVersion !== PHYSICAL_NODE_INTENT_VERSION) {
    throw new Error(`physical intent response must use ${PHYSICAL_NODE_INTENT_VERSION}`);
  }
  const normalized = {
    contractVersion: PHYSICAL_NODE_INTENT_VERSION,
    interpretation: normalizeInterpretation(response.interpretation),
    observationEvidence: clone2(object3(response.observationEvidence, "physical observation evidence")),
    discoverySnapshotDigest: digest2(response.discoverySnapshotDigest, "physical intent discoverySnapshotDigest"),
    discoveryBindingDigest: digest2(response.discoveryBindingDigest, "physical intent discoveryBindingDigest"),
    physicalExecutionAuthorized: bool(response.physicalExecutionAuthorized, "physical intent response.physicalExecutionAuthorized")
  };
  if (normalized.physicalExecutionAuthorized) {
    throw new Error("physical intent response cannot authorize execution");
  }
  return Object.freeze(normalized);
}
function normalizeIntent(value) {
  if (typeof value !== "string")
    throw new TypeError("Physical intent must be text");
  const result = value.replace(/\s+/g, " ").trim();
  if (!result || result.length > MAX_INTENT_CHARACTERS) {
    throw new TypeError(`Physical intent must contain 1-${MAX_INTENT_CHARACTERS} characters`);
  }
  return result;
}
function contentLength(response) {
  const raw = response.headers?.get?.("content-length");
  if (raw == null)
    return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("Physical node returned invalid Content-Length");
  return parsed;
}
async function boundedResponseText(response, maximumBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (!(value instanceof Uint8Array))
      throw new Error("Physical node returned invalid response bytes");
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Physical node response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
function createPhysicalNodeClient({
  baseUrl = DEFAULT_PHYSICAL_NODE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl);
  if (typeof fetchImpl !== "function")
    throw new TypeError("Physical node fetch implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new TypeError("Physical node timeout must be between 100 and 30000 ms");
  }
  async function request(path, { method = "GET", body, maximumBytes = MAX_RESPONSE_BYTES } = {}) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        method,
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...body === undefined ? {} : { "Content-Type": "application/json" }
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === "AbortError")
        throw new Error("Physical node did not respond before the timeout");
      throw new Error(`Physical Systems node is unavailable at ${origin}; start tinyedge-agent serve-physical-node locally`);
    }
    let raw;
    try {
      const declaredLength = contentLength(response);
      if (declaredLength != null && declaredLength > maximumBytes) {
        throw new Error("Physical node response is too large");
      }
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        throw new Error("Physical node returned a non-JSON response");
      }
      raw = await boundedResponseText(response, maximumBytes);
      if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
        throw new Error("Physical node response is too large");
      }
    } catch (error) {
      if (error?.name === "AbortError")
        throw new Error("Physical node did not respond before the timeout");
      if (Number.isInteger(response?.status))
        error.status = response.status;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("Physical node returned invalid JSON");
    }
    if (!response.ok) {
      const detail = typeof payload?.error === "string" ? payload.error.slice(0, 300) : `HTTP ${response.status}`;
      const error = new Error(`Physical node request failed: ${detail}`);
      error.status = response.status;
      if (typeof payload?.code === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(payload.code))
        error.code = payload.code;
      throw error;
    }
    return payload;
  }
  return Object.freeze({
    origin,
    async capabilities() {
      return normalizePhysicalCapabilityCatalog(await request("/v2/physical/capabilities", { maximumBytes: MAX_ROUTE_RESPONSE_BYTES }));
    },
    async previewCapability(value) {
      const body = normalizePhysicalRouteRequest(value);
      return normalizePhysicalRouteReceipt(await request("/v2/physical/routes:preview", {
        method: "POST",
        body,
        maximumBytes: MAX_ROUTE_RESPONSE_BYTES
      }), body);
    },
    async routeReceipt(receiptDigest) {
      const receipt = normalizePhysicalRouteReceipt(await request(physicalRouteReceiptPath(receiptDigest), { maximumBytes: MAX_ROUTE_RESPONSE_BYTES }));
      if (receipt.receiptDigest !== receiptDigest)
        throw new Error("Physical node returned a different route receipt");
      return receipt;
    },
    async inspect() {
      let candidates;
      try {
        candidates = normalizePhysicalCandidateSnapshot(await request("/v2/physical/candidates"));
      } catch (error) {
        if (error?.status !== 404)
          throw error;
        return normalizePhysicalNodeState(await request("/v1/physical/state"));
      }
      try {
        return normalizePhysicalNodeState(await request("/v1/physical/state"));
      } catch (error) {
        if (![404, 409].includes(error?.status))
          throw error;
        return candidates;
      }
    },
    async interpret(intent, expectedDiscoveryBindingDigest, snapshot = null) {
      const expectedBinding = digest2(expectedDiscoveryBindingDigest, "expected discovery binding digest");
      const normalizedIntent = normalizeIntent(intent);
      if (snapshot?.discovery?.mode === "candidates") {
        if (snapshot.discoveryBindingDigest !== expectedBinding) {
          throw new Error("Physical candidate snapshot does not match the inspected discovery");
        }
        const error = new Error("Planning requires a commissioned physical-system configuration; candidate discovery alone cannot ground this intent.");
        error.code = "PHYSICAL_COMMISSIONING_REQUIRED";
        throw error;
      }
      const response = normalizePhysicalIntentResponse(await request("/v1/physical/intents:interpret", {
        method: "POST",
        body: {
          contractVersion: PHYSICAL_NODE_INTENT_REQUEST_VERSION,
          text: normalizedIntent,
          expectedDiscoveryBindingDigest: expectedBinding
        }
      }));
      if (response.discoveryBindingDigest !== expectedBinding) {
        throw new Error("Physical node intent response does not match the inspected discovery");
      }
      return response;
    }
  });
}

// ../harness-gripper-check/packages/cli/src/physical/execution-client.js
var ROOT = "/v2/physical/execution";
var MAX_BYTES2 = 2 * 1024 * 1024;

class ExecutionHttpError extends Error {
}
var executionFailureMessage = (error, fallback) => error instanceof ExecutionHttpError ? error.message : fallback;
async function readJson(response, maximum = MAX_BYTES2) {
  if (response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new Error("Invalid content type");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum))
    throw new Error("Response too large");
  const reader = response.body?.getReader?.();
  if (!reader)
    throw new Error("Missing response");
  let size = 0;
  const chunks = [];
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > maximum)
        throw new Error("Response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return parseExecutionJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function createExecutionClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl);
  async function request(path, body, decode) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new ExecutionHttpError("Execution requires a configured server-side credential");
    try {
      const url = new URL(`${ROOT}${path}`, origin);
      const response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...body === undefined ? {} : { "Content-Type": "application/json" } },
        ...body === undefined ? {} : { body: JSON.stringify(body) }
      });
      if (response.redirected || response.type === "opaqueredirect" || response.url && response.url !== url.href)
        throw new Error("Redirect forbidden");
      if (!response.ok) {
        let code;
        try {
          code = (await readJson(response, 8192)).code;
        } catch {
          await response.body?.cancel?.().catch(() => {});
        }
        const explanation = response.status === 422 && {
          preconditions_unknown: "Fresh observed preconditions and confirmed idle state are required. Check the commissioned observation source; no invocation was dispatched.",
          configuration_unavailable: "The selected local configuration is not installed on this node."
        }[code];
        const error = new ExecutionHttpError(explanation || { 401: "Execution credentials were rejected", 403: "Execution request was not permitted", 409: "Run or configuration changed; refresh before acting", 404: "Execution service or run is unavailable", 503: "Execution is unavailable on this node" }[response.status] || "Execution request failed");
        error.status = [400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 503;
        throw error;
      }
      return decode(await readJson(response, path === "/runs" ? 1024 * 1024 : MAX_BYTES2));
    } catch (error) {
      if (error instanceof ExecutionHttpError)
        throw error;
      throw new Error("Execution transport or response is unavailable; no outcome is assumed");
    }
  }
  return Object.freeze({
    status: () => request("/status", undefined, normalizeExecutionStatus),
    runs: () => request("/runs", undefined, normalizePhysicalRunList),
    run(runId, expected = {}) {
      executionRunId(runId);
      return request(`/runs/${runId}`, undefined, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId }));
    },
    receipt(runId, expected = {}) {
      executionRunId(runId);
      return request(`/runs/${runId}/receipt`, undefined, (value) => normalizePhysicalRunReceipt(value, { ...expected, runId }));
    },
    snapshot(digest3) {
      executionHash(digest3);
      return request(`/snapshots/${digest3}`, undefined, (value) => normalizeExecutionSnapshot(value, digest3));
    },
    prepare(body, expected = {}) {
      executionFields(body, ["contractVersion", "routeReceiptDigest", "configurationId", "expectedConfigurationDigest", "idempotencyKey"]);
      if (body.contractVersion !== "physicalsystems-run-prepare-v1")
        throw new TypeError("Unsupported run preparation");
      executionHash(body.routeReceiptDigest);
      executionId(body.configurationId);
      executionHash(body.expectedConfigurationDigest);
      executionId(body.idempotencyKey);
      return request("/runs:prepare", body, (value) => assertRunMatches(normalizePhysicalRun(value), {
        ...expected,
        routeReceiptDigest: body.routeReceiptDigest,
        configurationId: body.configurationId,
        configurationDigest: body.expectedConfigurationDigest
      }));
    },
    approve(runId, body, expected = {}) {
      executionRunId(runId);
      executionFields(body, ["expectedRunDigest", "approvalDigest", "approved"]);
      executionHash(body.expectedRunDigest);
      executionHash(body.approvalDigest);
      if (body.approved !== true)
        throw new TypeError("Explicit approval is required");
      return request(`/runs/${runId}:approve`, body, (value) => {
        const run = assertRunMatches(normalizePhysicalRun(value), { ...expected, runId });
        if (run.approval.digest !== body.approvalDigest)
          throw new TypeError("Approval response does not match");
        return run;
      });
    },
    stop(runId, body, expected = {}) {
      executionRunId(runId);
      executionFields(body, ["reason"]);
      executionText(body.reason, 256);
      return request(`/runs/${runId}:stop`, body, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId }));
    },
    reconcile(runId, body, expected = {}) {
      executionRunId(runId);
      executionFields(body, ["expectedRunDigest"]);
      executionHash(body.expectedRunDigest);
      return request(`/runs/${runId}:reconcile`, body, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId }));
    }
  });
}

// ../harness-gripper-check/packages/cli/src/harness/execution-evidence.js
var CHECKS = [
  "configuredThresholds",
  "producerContract",
  "configuration",
  "frameGeometry",
  "markerGeometry",
  "imageQuality",
  "freshFrame",
  "captureProvenance",
  "sensorExposureAge",
  "detectorQuality",
  "distinctObjectSlots",
  "receiptStatus",
  "targetIdentified",
  "sourcePresent",
  "destinationClear"
];
var state = (value) => value === true ? "met" : value === false ? "violated" : "unknown";
var scalar2 = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var array3 = (value) => Array.isArray(value) ? value.slice(0, 8) : [];
function projectExecutionObservation(observation, { stage, at = null, mode: mode2 } = {}) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation))
    return null;
  const evidence = observation.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || evidence.mode !== mode2)
    return null;
  const checks = evidence.readinessChecks || {}, details = evidence.readinessCheckDetails || {};
  const projected = CHECKS.filter((name) => Object.hasOwn(checks, name)).map((name) => {
    const detail = details[name] || {}, metrics = [];
    const metric = (label, value, unit) => {
      if (scalar2(value) !== null)
        metrics.push({ label, value, unit });
    };
    if (name === "markerGeometry") {
      array3(detail.observed).forEach((item, index) => {
        metric(`Anchor ${index + 1} deviation`, item?.centerErrorPx, "pixel");
        metric(`Anchor ${index + 1} matched area`, item?.matchedPixels, "pixel-count");
        const threshold = array3(detail.thresholds).find((limit) => limit?.anchorId === item?.anchorId);
        metric(`Anchor ${index + 1} maximum deviation`, threshold?.maximumCenterErrorPx, "pixel");
        metric(`Anchor ${index + 1} minimum area`, threshold?.minimumPixels, "pixel-count");
      });
    } else if (name === "imageQuality") {
      metric("Sharpness", detail.observed?.sharpness, "detector-sharpness-score");
      metric("Minimum sharpness", detail.thresholds?.minimumSharpness, "detector-sharpness-score");
      metric("Brightness", detail.observed?.meanValue, "HSV-value-0-255");
      metric("Minimum brightness", detail.thresholds?.minimumMeanValue, "HSV-value-0-255");
      metric("Maximum brightness", detail.thresholds?.maximumMeanValue, "HSV-value-0-255");
    } else if (name === "detectorQuality") {
      array3(detail.observed).forEach((item, index) => {
        metric(`Marker ${index + 1} detection score`, item?.detectionScore, "color-coverage-score-not-probability");
        metric(`Marker ${index + 1} matched area`, item?.matchedPixels, "pixel-count");
      });
      metric("Minimum detection score", detail.thresholds?.minimumDetectionScore, "color-coverage-score-not-probability");
      metric("Minimum winner ratio", detail.thresholds?.minimumWinnerRatio, "ratio");
    } else if (name === "freshFrame") {
      metric("Age at observation check", detail.observed, "second");
      metric("Maximum age", detail.maximum, "second");
    } else if (name === "sensorExposureAge") {
      metric("Exposure age upper bound", detail.observedUpperBound, "nanosecond");
      metric("Configured maximum age", detail.configuredMaximum, "nanosecond");
    }
    const reported = state(checks[name]);
    return { name, status: detail.status && detail.status !== reported ? "unknown" : reported, metrics };
  });
  return {
    stage,
    at,
    mode: mode2,
    historical: true,
    preconditions: state(observation.preconditionsMet),
    verified: state(observation.verified),
    stopped: state(observation.stopped),
    checks: projected
  };
}

// ../harness-gripper-check/packages/cli/src/harness/execution-controller.js
var TERMINAL2 = new Set(["VERIFIED_SUCCESS", "FAILED", "CANCELLED", "BLOCKED"]);
var MAX_READ_AGE = 5000;
var needsResolution = (run) => !TERMINAL2.has(run.phase) || run.stopStatus === "STOP_UNCONFIRMED";
var printable = (value, length = 512) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, length);
var summary2 = (run) => ({
  runId: run.runId,
  runDigest: run.runDigest,
  phase: run.phase,
  stopStatus: run.stopStatus,
  mode: run.mode,
  capabilityId: run.capabilityId,
  configurationId: run.configurationId,
  updatedAt: run.updatedAt
});
function projectRun(run) {
  if (!run)
    return null;
  return {
    ...summary2(run),
    revision: run.revision,
    implementationId: run.implementationId,
    implementationDigest: run.implementationDigest,
    configurationDigest: run.configurationDigest,
    routeReceiptDigest: run.routeReceiptDigest,
    snapshotDigest: run.snapshotDigest,
    inputs: Object.fromEntries(Object.entries(run.inputs).slice(0, 128).map(([key, value]) => [key, printable(value)])),
    approval: run.approval,
    createdAt: run.createdAt,
    outcome: run.outcome,
    events: run.events.slice(-32).map(({ sequence, type, at }) => ({ sequence, type, at })),
    physicalExecutionAuthorized: false
  };
}
function createExecutionController({
  client,
  currentRoute = () => null,
  canPrepare = () => true,
  onChange = () => {},
  now = Date.now,
  pollMs = 1000
} = {}) {
  let disposed = false, viewers = 0, timer = null, readPending = null;
  let actionPending = null, stopPending = false;
  let availability = "unchecked", status = null, error = null, runs = [], run = null, receipt = null;
  let observedAt = 0, contextRevision = 0;
  const emit = () => {
    if (!disposed)
      onChange();
  };
  const fresh = () => availability === "available" && now() >= observedAt && now() - observedAt < MAX_READ_AGE;
  const route = () => {
    const value = currentRoute();
    return value?.decision?.decision_status === "selected" && value.physicalExecutionAuthorized === false ? value : null;
  };
  const eligibleConfigurations = () => {
    const value = route();
    return value && status?.availability === "available" ? status.configurations.filter((item) => item.capabilityId === value.capabilityId && item.implementationId === value.decision.selected_implementation_id) : [];
  };
  const unresolvedRuns = () => [...new Map([...runs, ...run ? [run] : []].filter(needsResolution).map((item) => [item.runId, item])).values()];
  const unresolved = () => unresolvedRuns().length > 0;
  const configurationReason = () => {
    if (!status || status.availability !== "available")
      return "No available installed configuration. Configure a trusted local controller and observation source first.";
    if (!status.configurations.length)
      return "No local configuration is installed.";
    if (!route())
      return `${status.configurations.length} local configuration(s) installed. Obtain a successful capability route before selecting one.`;
    if (!eligibleConfigurations().length)
      return "Installed configurations do not match the capability and implementation selected by this route.";
    if (unresolved())
      return "An unresolved invocation must be stopped or reconciled before preparing another.";
    return "Select the exact local configuration. Installation and route selection do not establish current physical readiness.";
  };
  const approvalReady = () => Boolean(fresh() && !actionPending && !stopPending && canPrepare() && run?.phase === "WAITING_FOR_APPROVAL" && run.stopStatus === "NOT_REQUESTED" && run.approval.approvedAt === null && Date.parse(run.approval.expiresAt) > now() && route()?.receiptDigest === run.routeReceiptDigest && eligibleConfigurations().some((item) => item.configurationId === run.configurationId && item.configurationDigest === run.configurationDigest && item.implementationDigest === run.implementationDigest && item.mode === run.mode));
  const snapshot = () => ({
    availability,
    status: status ? { availability: status.availability, mode: status.mode, reason: status.reason } : null,
    error,
    receivedAt: observedAt ? new Date(observedAt).toISOString() : null,
    pending: actionPending,
    stopPending,
    configurations: eligibleConfigurations(),
    configurationReason: configurationReason(),
    runs: runs.slice(0, 32).map(summary2),
    run: projectRun(run),
    receipt,
    activeRuns: unresolvedRuns().map((item) => ({ ...summary2(item), canStop: !disposed && !stopPending })),
    canPrepare: Boolean(!disposed && fresh() && !actionPending && !stopPending && canPrepare() && !unresolved() && eligibleConfigurations().length),
    canApprove: !disposed && approvalReady(),
    canStop: Boolean(!disposed && run && (!TERMINAL2.has(run.phase) || run.stopStatus === "STOP_UNCONFIRMED") && !stopPending),
    canReconcile: Boolean(!disposed && fresh() && run?.phase === "OUTCOME_UNKNOWN" && !actionPending && !stopPending),
    physicalExecutionAuthorized: false
  });
  const acceptRun = (value) => {
    const known = run?.runId === value.runId ? run : runs.find((item) => item.runId === value.runId);
    if (known) {
      if (value.revision < known.revision)
        return false;
      assertRunMatches(value, known);
    }
    run = value;
    const history = [value, ...runs.filter((item) => item.runId !== value.runId)];
    runs = history.filter((item, index) => index < 128 || needsResolution(item));
    if (receipt?.runDigest !== value.runDigest)
      receipt = null;
    return true;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && viewers) {
      timer = setTimeout(() => {
        refresh().finally(schedule);
      }, pollMs);
      timer.unref?.();
    }
  };
  async function refresh() {
    if (disposed || readPending)
      return readPending;
    if (!client) {
      availability = "unavailable";
      error = "Execution integration is unavailable";
      emit();
      return;
    }
    readPending = (async () => {
      try {
        const [statusResult, listingResult] = await Promise.allSettled([client.status(), client.runs()]);
        if (disposed)
          return;
        if (statusResult.status === "fulfilled")
          status = statusResult.value;
        if (statusResult.status === "rejected")
          throw statusResult.reason;
        if (listingResult.status === "rejected")
          throw listingResult.reason;
        const nextStatus = statusResult.value, listing = listingResult.value;
        const known = new Map(runs.map((item) => [item.runId, item]));
        runs = listing.runs.map((item) => {
          const previous = known.get(item.runId);
          if (previous && item.revision < previous.revision)
            return previous;
          if (previous)
            assertRunMatches(item, previous);
          return item;
        });
        for (const previous of known.values())
          if (needsResolution(previous) && !runs.some((item) => item.runId === previous.runId))
            runs.push(previous);
        if (run && !runs.some((item) => item.runId === run.runId))
          runs.unshift(run);
        if (!run)
          run = runs.find(needsResolution) || null;
        if (run) {
          const expected = run;
          const value = await client.run(expected.runId, expected);
          if (disposed)
            return;
          if (run?.runId === expected.runId)
            acceptRun(value);
        }
        availability = nextStatus.availability;
        error = nextStatus.reason;
        observedAt = now();
        emit();
      } catch (failure2) {
        if (!disposed) {
          availability = "unavailable";
          error = status?.availability === "unavailable" && status.reason ? status.reason : executionFailureMessage(failure2, "Execution status is unavailable. No outcome is assumed; Stop remains available for the known run.");
          emit();
        }
      }
    })().finally(() => {
      readPending = null;
    });
    return readPending;
  }
  async function action(kind, body) {
    if (disposed || !client)
      throw new Error("Execution integration is unavailable");
    if (kind === "refresh") {
      executionFields(body, []);
      await refresh();
      return snapshot();
    }
    if (kind === "stop") {
      executionFields(body, ["runId", "reason"]);
      executionRunId(body.runId);
      const expected2 = run?.runId === body.runId ? run : runs.find((item) => item.runId === body.runId);
      if (!expected2 || !needsResolution(expected2) || stopPending)
        throw new Error("Request Stop for a known unresolved run");
      if (body.reason !== "operator-requested-stop")
        throw new TypeError("Unsupported stop reason");
      stopPending = true;
      emit();
      try {
        const value = await client.stop(expected2.runId, { reason: body.reason }, expected2);
        assertRunMatches(value, expected2);
        if (!disposed) {
          if (run?.runId === expected2.runId)
            acceptRun(value);
          else {
            const latest = runs.find((item) => item.runId === expected2.runId);
            if (!latest || value.revision >= latest.revision) {
              if (latest)
                assertRunMatches(value, latest);
              runs = runs.map((item) => item.runId === value.runId ? value : item);
            }
          }
          error = null;
        }
      } catch {
        if (!disposed) {
          availability = "unavailable";
          error = "Stop could not be confirmed. Treat the outcome as unknown and use the physical stop procedure.";
        }
        throw new Error("Stop could not be confirmed; use the physical stop procedure");
      } finally {
        stopPending = false;
        emit();
      }
      return snapshot();
    }
    if (actionPending || stopPending)
      throw new Error("An operator execution request is already pending");
    if (kind === "select" || kind === "receipt") {
      executionFields(body, ["runId"]);
      executionRunId(body.runId);
      const known = runs.find((item) => item.runId === body.runId);
      if (!known)
        throw new Error("Refresh and select a known run");
      actionPending = kind;
      emit();
      try {
        if (kind === "select") {
          const value = await client.run(body.runId, known);
          if (!disposed) {
            const latest = runs.find((item) => item.runId === body.runId);
            acceptRun(latest && latest.revision > value.revision ? latest : value);
            receipt = null;
          }
        } else {
          const value = await client.receipt(body.runId, known);
          const configurationDigest = value.snapshot.contractVersion === "physicalsystems-run-snapshot-v1" ? value.snapshot.configurationSnapshotDigest : null;
          if (configurationDigest && configurationDigest !== value.run.configurationDigest)
            throw new Error("Receipt configuration reference does not match the run");
          const evidenceDigest = value.run.outcome?.evidenceDigest;
          const [configurationSnapshot, evidenceSnapshot] = await Promise.all([
            configurationDigest ? client.snapshot(configurationDigest) : null,
            evidenceDigest ? client.snapshot(evidenceDigest) : null
          ]);
          if (!disposed && run?.runId === value.run.runId && acceptRun(value.run)) {
            receipt = {
              receiptDigest: value.receiptDigest,
              runId: value.run.runId,
              runDigest: value.run.runDigest,
              snapshotDigest: value.run.snapshotDigest,
              configurationSnapshotDigest: configurationSnapshot?.snapshotDigest || null,
              evidenceDigest: evidenceSnapshot?.snapshotDigest || null,
              preparation: projectExecutionObservation(value.snapshot.preparationObservation, { stage: "preparation", at: value.run.createdAt, mode: value.run.mode }),
              verification: projectExecutionObservation(evidenceSnapshot?.snapshot, { stage: "verification", at: value.run.updatedAt, mode: value.run.mode })
            };
          }
        }
        return snapshot();
      } finally {
        actionPending = null;
        emit();
      }
    }
    if (kind === "prepare") {
      executionFields(body, ["configurationId", "expectedConfigurationDigest", "routeReceiptDigest"]);
      executionId(body.configurationId);
      executionHash(body.expectedConfigurationDigest);
      executionHash(body.routeReceiptDigest);
      const selected = eligibleConfigurations().find((item) => item.configurationId === body.configurationId && item.configurationDigest === body.expectedConfigurationDigest);
      const current = route();
      if (!snapshot().canPrepare || !selected || current?.receiptDigest !== body.routeReceiptDigest)
        throw new Error("A current successful route and available exact configuration are required");
      actionPending = kind;
      emit();
      try {
        const value = await client.prepare({
          contractVersion: "physicalsystems-run-prepare-v1",
          configurationId: selected.configurationId,
          expectedConfigurationDigest: selected.configurationDigest,
          routeReceiptDigest: current.receiptDigest,
          idempotencyKey: `prepare-${randomUUID3()}`
        }, {
          mode: selected.mode,
          capabilityId: current.capabilityId,
          implementationId: selected.implementationId,
          implementationDigest: selected.implementationDigest,
          inputs: Object.fromEntries(current.request.arguments.map((argument) => [argument.name, argument.value]))
        });
        if (!disposed) {
          run = null;
          acceptRun(value);
          receipt = null;
          error = null;
        }
      } catch (failure2) {
        if (!disposed) {
          availability = "unavailable";
          error = executionFailureMessage(failure2, "Preparation was not confirmed. Refresh run history before attempting another preparation.");
        }
        throw new Error(executionFailureMessage(failure2, "Preparation was not confirmed; inspect run history, do not blindly repeat"));
      } finally {
        actionPending = null;
        emit();
      }
      return snapshot();
    }
    if (!run || body?.runId !== run.runId || body?.expectedRunDigest !== run.runDigest)
      throw new Error("Run changed; review the current run before acting");
    const expected = run, currentContext = contextRevision;
    if (kind === "approve") {
      executionFields(body, ["runId", "expectedRunDigest", "approvalDigest", "approved"]);
      if (!approvalReady() || body.approved !== true || body.approvalDigest !== run.approval.digest)
        throw new Error("Review and explicitly approve the current unexpired run");
    } else if (kind === "reconcile") {
      executionFields(body, ["runId", "expectedRunDigest"]);
      if (!snapshot().canReconcile)
        throw new Error("Only an uncertain run can be reconciled; no retry will be issued");
    } else
      throw new TypeError("Unsupported operator execution action");
    actionPending = kind;
    emit();
    try {
      if (disposed || currentContext !== contextRevision)
        throw new Error("Workcell changed");
      const value = kind === "approve" ? await client.approve(expected.runId, { expectedRunDigest: expected.runDigest, approvalDigest: body.approvalDigest, approved: true }, expected) : await client.reconcile(expected.runId, { expectedRunDigest: expected.runDigest }, expected);
      if (!disposed && run?.runId === expected.runId) {
        acceptRun(value);
        error = null;
      }
    } catch {
      if (!disposed) {
        availability = "unavailable";
        error = "Run action was not confirmed. No success or retry is assumed; refresh or request Stop.";
      }
      throw new Error("Run action was not confirmed; inspect the same run before acting again");
    } finally {
      actionPending = null;
      emit();
    }
    return snapshot();
  }
  return {
    snapshot,
    refresh,
    action,
    contextChanged() {
      contextRevision += 1;
      emit();
    },
    connect() {
      viewers += 1;
      refresh().finally(schedule);
      let closed = false;
      return () => {
        if (closed)
          return;
        closed = true;
        viewers = Math.max(0, viewers - 1);
        if (!viewers)
          clearTimeout(timer);
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    }
  };
}

// ../harness-gripper-check/packages/cli/src/physical/commissioning-client.js
var GRIPPER_CHECK_VERSION = "physicalsystems-gripper-check-v1";
var GRIPPER_JOINTS = Object.freeze(["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]);
var ROOT2 = "/v2/physical/commissioning/gripper";
var assert = (condition) => {
  if (!condition)
    throw new TypeError("Gripper check response failed contract validation");
};
var number = (value, minimum = -1e5, maximum = 1e5) => assert(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
var date = (value) => {
  executionText(value, 64);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
};
var optionalText = (value) => {
  if (value !== null)
    executionText(value, 512);
};
var freeze2 = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze2);
    Object.freeze(value);
  }
  return value;
};
var RECOVERY_FIELDS = ["trialNodeSessionId", "recovery", "recoveryClearance", "canInspectRecovery", "canConfirmRecovery"];
var RECOVERY_BINDING = ["trialId", "trialDigest", "trialNodeSessionId", "nodeSessionId", "configurationDigest", "deviceIdentity"];
function recoveryBinding(value) {
  for (const key of ["trialId", "trialNodeSessionId", "nodeSessionId"])
    executionId(value[key]);
  executionHash(value.trialDigest);
  executionHash(value.configurationDigest);
  executionText(value.deviceIdentity);
}
function recoveryReceipt(value) {
  executionFields(value, ["id", "digest", ...RECOVERY_BINDING, "recoveryDigest", "confirmedAt", "inspectionDigest", "priorRunDigest", "priorRevision"]);
  executionId(value.id);
  executionHash(value.digest);
  recoveryBinding(value);
  executionHash(value.recoveryDigest);
  date(value.confirmedAt);
  executionHash(value.inspectionDigest);
  executionHash(value.priorRunDigest);
  assert(Number.isSafeInteger(value.priorRevision) && value.priorRevision > 0);
  assert(value.digest === executionDigest(value, "digest"));
  return value;
}
var originSession = (value) => value.trialNodeSessionId ?? value.nodeSessionId;
function recoveryMatches(value, expected) {
  return Boolean(expected?.trial && expected.configuration && value.trialId === expected.trial.trialId && value.trialDigest === expected.trial.digest && value.trialNodeSessionId === originSession(expected) && value.configurationDigest === expected.configuration.digest && value.deviceIdentity === expected.configuration.deviceIdentity);
}
function gripperRecoveryCleared(value, expected = value) {
  if (value?.trial?.phase !== "OUTCOME_UNKNOWN" || !value.recoveryClearance)
    return false;
  recoveryReceipt(value.recoveryClearance);
  return recoveryMatches(value.recoveryClearance, value) && recoveryMatches(value.recoveryClearance, expected);
}
function assertGripperRecoveryMatches(value, expected) {
  assert(value.trial?.phase === "OUTCOME_UNKNOWN" && expected?.trial && value.configuration && expected.configuration);
  assert(value.trialNodeSessionId === originSession(expected) && value.configuration.digest === expected.configuration.digest && value.configuration.deviceIdentity === expected.configuration.deviceIdentity);
  assert(["trialId", "digest", "startPosition", "targetPosition", "maximumDurationSeconds", "approvalExpiresAt"].every((key) => value.trial[key] === expected.trial[key]));
  return value;
}
function normalizeGripperCheck(value) {
  const recoverySupported = RECOVERY_FIELDS.some((key) => Object.hasOwn(value || {}, key));
  executionFields(value, ["contractVersion", "nodeSessionId", "configuration", "inspection", "trial", "canInspect", "canPrepare", "canApprove", "canStop", "blockedReason", ...recoverySupported ? RECOVERY_FIELDS : []]);
  assert(value.contractVersion === GRIPPER_CHECK_VERSION);
  executionId(value.nodeSessionId);
  for (const key of ["canInspect", "canPrepare", "canApprove", "canStop"])
    assert(typeof value[key] === "boolean");
  optionalText(value.blockedReason);
  const { configuration: c, inspection: i, trial: t } = value;
  if (c !== null) {
    executionFields(c, ["id", "digest", "displayName", "deviceIdentity", "calibrationDigest", "minimum", "maximum", "maximumDelta", "maximumDurationSeconds", "maximumStep", "stepIntervalSeconds", "tolerance"]);
    executionId(c.id);
    executionHash(c.digest);
    executionText(c.displayName);
    executionText(c.deviceIdentity);
    executionHash(c.calibrationDigest);
    for (const key of ["minimum", "maximum", "maximumDelta", "maximumStep", "tolerance"])
      number(c[key], 0, 100);
    number(c.maximumDurationSeconds, 0.001, 120);
    number(c.stepIntervalSeconds, 0.001, 10);
    assert(c.minimum < c.maximum && c.maximumDelta > 0 && c.maximumStep > 0 && c.tolerance > 0 && c.maximumStep <= c.maximumDelta);
  }
  if (i !== null) {
    executionFields(i, ["id", "digest", "observedAt", "expiresAt", "ready", "positions", "torqueEnabled", "checks", "gripperPosition"]);
    executionId(i.id);
    executionHash(i.digest);
    date(i.observedAt);
    date(i.expiresAt);
    assert(Date.parse(i.expiresAt) > Date.parse(i.observedAt));
    assert(typeof i.ready === "boolean");
    executionFields(i.positions, GRIPPER_JOINTS);
    executionFields(i.torqueEnabled, GRIPPER_JOINTS);
    GRIPPER_JOINTS.forEach((joint) => {
      if (i.positions[joint] !== null)
        number(i.positions[joint]);
      assert(i.torqueEnabled[joint] === null || typeof i.torqueEnabled[joint] === "boolean");
    });
    if (i.gripperPosition !== null)
      number(i.gripperPosition);
    assert(Array.isArray(i.checks) && i.checks.length <= 64);
    i.checks.forEach((check2) => {
      executionFields(check2, ["code", "state", "message"]);
      executionText(check2.code, 128);
      assert(["met", "violated", "unknown"].includes(check2.state));
      executionText(check2.message, 512);
    });
    if (i.ready)
      assert(i.gripperPosition !== null && GRIPPER_JOINTS.every((joint) => i.positions[joint] !== null && i.torqueEnabled[joint] === false) && i.checks.length > 0 && i.checks.every((check2) => check2.state === "met"));
  }
  if (t !== null) {
    executionFields(t, ["trialId", "digest", "phase", "approvalExpiresAt", "startPosition", "targetPosition", "maximumDurationSeconds", "latestPosition", "stopStatus", "message"]);
    executionId(t.trialId);
    executionHash(t.digest);
    assert(["WAITING_FOR_APPROVAL", "RUNNING", "COMPLETED", "STOPPED", "FAILED", "OUTCOME_UNKNOWN"].includes(t.phase));
    date(t.approvalExpiresAt);
    number(t.startPosition);
    number(t.targetPosition, 0, 100);
    number(t.maximumDurationSeconds, 0.001, 120);
    if (t.latestPosition !== null)
      number(t.latestPosition);
    assert([null, "STOPPING", "STOPPED", "STOP_UNCONFIRMED"].includes(t.stopStatus));
    optionalText(t.message);
    if (t.phase === "COMPLETED")
      assert(t.stopStatus === "STOPPED" && t.latestPosition !== null);
  }
  if (value.canPrepare)
    assert(c !== null && i?.ready === true);
  if (value.canApprove)
    assert(c !== null && t?.phase === "WAITING_FOR_APPROVAL" && t.stopStatus === null);
  if (value.canStop)
    assert(t !== null);
  if (recoverySupported) {
    assert(typeof value.canInspectRecovery === "boolean" && typeof value.canConfirmRecovery === "boolean");
    if (t)
      executionId(value.trialNodeSessionId);
    else
      assert(value.trialNodeSessionId === null);
    const offer = value.recovery;
    if (offer !== null) {
      executionFields(offer, ["id", "digest", ...RECOVERY_BINDING, "observedAt", "expiresAt", "ready", "positions", "torqueEnabled", "checks"]);
      executionId(offer.id);
      executionHash(offer.digest);
      recoveryBinding(offer);
      date(offer.observedAt);
      date(offer.expiresAt);
      assert(Date.parse(offer.expiresAt) > Date.parse(offer.observedAt) && typeof offer.ready === "boolean");
      executionFields(offer.positions, GRIPPER_JOINTS);
      executionFields(offer.torqueEnabled, GRIPPER_JOINTS);
      GRIPPER_JOINTS.forEach((joint) => {
        number(offer.positions[joint]);
        assert(typeof offer.torqueEnabled[joint] === "boolean");
      });
      assert(Array.isArray(offer.checks) && offer.checks.length > 0 && offer.checks.length <= 64);
      offer.checks.forEach((check2) => {
        executionFields(check2, ["code", "state", "message"]);
        executionText(check2.code, 128);
        assert(["met", "violated", "unknown"].includes(check2.state));
        executionText(check2.message, 512);
      });
      if (offer.ready)
        assert(GRIPPER_JOINTS.every((joint) => offer.torqueEnabled[joint] === false) && offer.checks.every((check2) => check2.state === "met"));
      assert(offer.digest === executionDigest(offer, "digest") && recoveryMatches(offer, value) && offer.nodeSessionId === value.nodeSessionId && t.phase === "OUTCOME_UNKNOWN");
    }
    if (value.recoveryClearance !== null)
      recoveryReceipt(value.recoveryClearance);
    if (value.canInspectRecovery || value.canConfirmRecovery)
      assert(t?.phase === "OUTCOME_UNKNOWN" && c !== null && !gripperRecoveryCleared(value));
    if (value.canConfirmRecovery)
      assert(offer?.ready === true);
  }
  return freeze2(value);
}
var commissioningUnresolved = (status) => Boolean(status?.trial && !gripperRecoveryCleared(status) && (!["COMPLETED", "STOPPED", "FAILED"].includes(status.trial.phase) || status.trial.stopStatus !== "STOPPED"));
function assertGripperCheckMatches(value, expected) {
  assert(value.nodeSessionId === expected.nodeSessionId && value.configuration?.digest === expected.configuration?.digest);
  assert(value.trial && expected.trial && ["trialId", "digest", "startPosition", "targetPosition", "maximumDurationSeconds", "approvalExpiresAt"].every((key) => value.trial[key] === expected.trial[key]));
  return value;
}

class CommissioningHttpError extends Error {
}
var commissioningFailureMessage = (error, fallback) => error instanceof CommissioningHttpError ? error.message : fallback;
async function readJson2(response) {
  assert(response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json");
  const length = response.headers.get("content-length");
  assert(length === null || /^[0-9]+$/.test(length) && Number(length) <= 65536);
  const reader = response.body?.getReader?.();
  assert(reader);
  let size = 0;
  const chunks = [];
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      assert(size <= 65536);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return parseExecutionJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function createCommissioningClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl);
  async function request(action, body) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new CommissioningHttpError("Gripper check requires an execution credential saved in the native encrypted credential store.");
    try {
      const url = new URL(`${ROOT2}${action ? `/${action}` : ""}`, origin);
      const response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(action === "inspect" || action.startsWith("recovery/") ? 35000 : 5000),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...body === undefined ? {} : { "Content-Type": "application/json" } },
        ...body === undefined ? {} : { body: JSON.stringify(body) }
      });
      assert(!response.redirected && response.type !== "opaqueredirect" && (!response.url || response.url === url.href));
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        const error = new CommissioningHttpError({
          401: "The Node rejected the execution credential.",
          403: "This gripper check request was not permitted.",
          404: "This Node does not support the gripper check.",
          501: "This Node does not support the gripper check.",
          409: "The Node session, inspection or trial changed. Refresh and review its retained state.",
          422: "The robot did not meet the configured gripper check requirements. Inspect its current state.",
          503: "Gripper check is unavailable on this Node."
        }[response.status] || "The gripper check request was not confirmed.");
        error.status = response.status;
        throw error;
      }
      const status = normalizeGripperCheck(await readJson2(response));
      if (body && status.nodeSessionId !== body.expectedNodeSessionId)
        throw new Error("Node session changed");
      if (body?.trialId && (status.trial?.trialId !== body.trialId || body.trialDigest && status.trial.digest !== body.trialDigest))
        throw new Error("Trial changed");
      if (action === "prepare" && (status.configuration?.digest !== body.configurationDigest || status.trial?.targetPosition !== body.targetPosition || status.trial?.phase !== "WAITING_FOR_APPROVAL"))
        throw new Error("Proposal changed");
      if (action === "approve" && status.trial.phase === "WAITING_FOR_APPROVAL")
        throw new Error("Approval was not acknowledged");
      if (action === "recovery/inspect" && (!status.recovery || status.recovery.nodeSessionId !== body.expectedNodeSessionId))
        throw new Error("Recovery inspection was not acknowledged");
      if (action === "recovery/confirm" && (!gripperRecoveryCleared(status) || status.recoveryClearance.nodeSessionId !== body.expectedNodeSessionId || status.recoveryClearance.recoveryDigest !== body.recoveryDigest))
        throw new Error("Durable recovery clearance was not acknowledged");
      return status;
    } catch (error) {
      if (error instanceof CommissioningHttpError)
        throw error;
      throw new Error("Gripper check transport or response is unavailable; no outcome is assumed.");
    }
  }
  return Object.freeze({
    status: () => request(""),
    inspect(body) {
      executionFields(body, ["expectedNodeSessionId"]);
      executionId(body.expectedNodeSessionId);
      return request("inspect", body);
    },
    prepare(body) {
      executionFields(body, ["expectedNodeSessionId", "configurationDigest", "inspectionDigest", "targetPosition"]);
      executionId(body.expectedNodeSessionId);
      executionHash(body.configurationDigest);
      executionHash(body.inspectionDigest);
      number(body.targetPosition, 0, 100);
      return request("prepare", body);
    },
    approve(body) {
      executionFields(body, ["expectedNodeSessionId", "trialId", "trialDigest", "approved"]);
      executionId(body.expectedNodeSessionId);
      executionId(body.trialId);
      executionHash(body.trialDigest);
      assert(body.approved === true);
      return request("approve", body);
    },
    stop(body) {
      executionFields(body, ["expectedNodeSessionId", "trialId", "reason"]);
      executionId(body.expectedNodeSessionId);
      executionId(body.trialId);
      executionText(body.reason, 256);
      return request("stop", body);
    },
    recoveryInspect(body) {
      executionFields(body, ["expectedNodeSessionId", "trialId", "trialDigest"]);
      executionId(body.expectedNodeSessionId);
      executionId(body.trialId);
      executionHash(body.trialDigest);
      return request("recovery/inspect", body);
    },
    recoveryConfirm(body) {
      executionFields(body, ["expectedNodeSessionId", "trialId", "trialDigest", "recoveryDigest", "confirmed"]);
      executionId(body.expectedNodeSessionId);
      executionId(body.trialId);
      executionHash(body.trialDigest);
      executionHash(body.recoveryDigest);
      assert(body.confirmed === true);
      return request("recovery/confirm", body);
    }
  });
}

// ../harness-gripper-check/packages/cli/src/harness/commissioning-controller.js
var COMMISSIONING_MAXIMUM_AGE_MS = 5000;
function createCommissioningController({ client, initialStatus = null, recoveryOnly = false, canAct = () => true, onChange = () => {}, now = Date.now, pollMs = 1000 } = {}) {
  let status = initialStatus, available = false, receivedAt = null, message = null, pending = null, stopPending = false;
  let recoveryStatus = null, recoveryAvailable = false, recoveryReceivedAt = null, recoveryMessage = null;
  let recoveryRequestStatus = null;
  const attemptedApprovals = new Set;
  const attemptedRecoveries = new Set;
  let disposed = false, timer = null, reading = null, epoch = 0, uncertain = false;
  const emit = () => {
    if (!disposed)
      onChange();
  };
  const fresh = () => Boolean(available && receivedAt !== null && now() >= receivedAt && now() - receivedAt < COMMISSIONING_MAXIMUM_AGE_MS);
  const recoveryFresh = () => Boolean(recoveryAvailable && recoveryReceivedAt !== null && now() >= recoveryReceivedAt && now() - recoveryReceivedAt < COMMISSIONING_MAXIMUM_AGE_MS);
  const recoveryKey = (value) => `${value.nodeSessionId}:${value.trial?.trialId}:${value.recovery?.digest}`;
  const active = () => commissioningUnresolved(status);
  const snapshot = () => ({
    status: status ? { ...status, canApprove: status.canApprove && !attemptedApprovals.has(`${status.nodeSessionId}:${status.trial?.trialId}`) } : null,
    fresh: fresh(),
    available,
    receivedAt,
    maximumAgeMs: COMMISSIONING_MAXIMUM_AGE_MS,
    recoveryStatus: recoveryStatus ? { ...recoveryStatus, canConfirmRecovery: recoveryStatus.canConfirmRecovery && !attemptedRecoveries.has(recoveryKey(recoveryStatus)) } : null,
    recoveryAvailable,
    recoveryFresh: recoveryFresh(),
    recoveryReceivedAt,
    pending,
    stopPending,
    message: status?.trial?.phase === "WAITING_FOR_APPROVAL" && attemptedApprovals.has(`${status.nodeSessionId}:${status.trial.trialId}`) ? "Approval was already submitted. Its delivery is uncertain; request Stop instead of approving again." : recoveryMessage ?? (recoveryAvailable ? recoveryStatus?.blockedReason : message),
    unresolved: active() || uncertain
  });
  const invalidate = (error, fallback) => {
    available = false;
    receivedAt = null;
    message = commissioningFailureMessage(error, fallback);
  };
  const invalidateRecovery = () => {
    ++epoch;
    recoveryAvailable = false;
    recoveryReceivedAt = null;
    emit();
  };
  async function cancelRecovery() {
    const current = recoveryRequestStatus, original = status;
    invalidateRecovery();
    if (!current || current.nodeSessionId === original?.nodeSessionId)
      return;
    assertGripperRecoveryMatches(current, original);
    const next = await client.stop({ expectedNodeSessionId: current.nodeSessionId, trialId: current.trial.trialId, reason: "operator-requested-stop" });
    assertGripperRecoveryMatches(next, original);
  }
  const acceptRecovery = (next, expected) => {
    assertGripperRecoveryMatches(next, expected);
    recoveryStatus = next;
    recoveryAvailable = true;
    recoveryReceivedAt = now();
    recoveryMessage = next.blockedReason;
    if (gripperRecoveryCleared(next, expected)) {
      status = next;
      available = true;
      receivedAt = now();
      uncertain = false;
    }
  };
  const accept = (next) => {
    if (active()) {
      const before = status.trial, after = next.trial;
      assertGripperCheckMatches(next, status);
      if (before.phase === "OUTCOME_UNKNOWN" && after.phase !== "OUTCOME_UNKNOWN" || before.phase === "RUNNING" && after.phase === "WAITING_FOR_APPROVAL")
        throw new Error("Unknown trial cannot be silently cleared");
    }
    if (status?.trial?.trialId !== next.trial?.trialId || status?.trial?.digest !== next.trial?.digest) {
      recoveryStatus = recoveryRequestStatus = null;
      recoveryAvailable = false;
      recoveryReceivedAt = null;
      recoveryMessage = null;
    }
    if (gripperRecoveryCleared(next, status || next)) {
      recoveryStatus = next;
      recoveryAvailable = true;
      recoveryReceivedAt = now();
      recoveryMessage = next.blockedReason;
    }
    status = next;
    available = true;
    receivedAt = now();
    message = next.blockedReason;
    uncertain = false;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && (active() || uncertain)) {
      timer = setTimeout(() => {
        refresh().finally(schedule);
      }, pollMs);
      timer.unref?.();
    }
  };
  const refreshRecovery = (next) => {
    if (!recoveryAvailable || !recoveryStatus?.recovery)
      return false;
    assertGripperRecoveryMatches(next, status);
    if (next.nodeSessionId !== recoveryStatus.nodeSessionId || !next.recovery || next.recovery.digest !== recoveryStatus.recovery.digest || Date.parse(next.recovery.expiresAt) <= now()) {
      throw new Error("Recovery evidence changed or expired");
    }
    recoveryStatus = next;
    recoveryReceivedAt = now();
    recoveryMessage = next.blockedReason;
    return true;
  };
  async function refresh() {
    if (disposed || reading || pending || stopPending)
      return reading;
    if (!client) {
      invalidate(null, "This host does not provide the gripper check integration.");
      emit();
      return;
    }
    const revision = epoch;
    reading = (async () => {
      try {
        const next = await client.status();
        if (!disposed && revision === epoch) {
          const matchedRecovery = refreshRecovery(next);
          if (!recoveryOnly && !(matchedRecovery && next.nodeSessionId !== status.nodeSessionId))
            accept(next);
        }
      } catch (error) {
        if (!disposed && revision === epoch) {
          if (recoveryAvailable) {
            recoveryAvailable = false;
            recoveryReceivedAt = null;
            recoveryMessage = "Recovery status changed, expired or became unavailable. Check the current robot state again before confirming.";
          }
          invalidate(error, "Gripper check status is unavailable. Retain the original trial; no outcome is assumed.");
        }
      } finally {
        reading = null;
        emit();
      }
    })();
    return reading;
  }
  async function action(kind, body) {
    if (disposed || !client)
      throw new Error("Gripper check integration is unavailable");
    if (kind === "refresh") {
      executionFields(body, []);
      await refresh();
      schedule();
      return snapshot();
    }
    if (kind === "stop") {
      executionFields(body, ["trialId", "reason"]);
      executionId(body.trialId);
      if (body.reason !== "operator-requested-stop" || !active() || status.trial.trialId !== body.trialId || stopPending)
        throw new Error("Request Stop for the exact unresolved gripper trial");
      const expected = status;
      stopPending = true;
      emit();
      try {
        const [original, recovery] = await Promise.allSettled([client.stop({ expectedNodeSessionId: expected.nodeSessionId, trialId: expected.trial.trialId, reason: body.reason }), cancelRecovery()]);
        if (original.status === "rejected")
          throw original.reason;
        if (recovery.status === "rejected")
          throw recovery.reason;
        if (gripperRecoveryCleared(original.value, expected))
          throw new Error("Inspect the durable clearance separately; Stop does not acknowledge recovery");
        accept(original.value);
      } catch (error) {
        uncertain = true;
        recoveryMessage = null;
        invalidate(error, "Gripper Stop is unconfirmed. Retain the trial and use the independent motor power cutoff.");
        throw new Error(message);
      } finally {
        stopPending = false;
        emit();
        schedule();
      }
      return snapshot();
    }
    if (kind === "recoveryInspect" || kind === "recoveryConfirm") {
      executionFields(body, ["trialId", "trialDigest", ...kind === "recoveryConfirm" ? ["recoveryDigest", "confirmed"] : []]);
      executionId(body.trialId);
      executionHash(body.trialDigest);
      if (pending || stopPending || !canAct() || !active() || body.trialId !== status.trial.trialId || body.trialDigest !== status.trial.digest)
        throw new Error("Review recovery for the exact retained gripper trial on its connected owner");
      const expected = status, current = recoveryStatus;
      if (kind === "recoveryConfirm") {
        executionHash(body.recoveryDigest);
        if (!recoveryFresh() || !current?.canConfirmRecovery || !current.recovery?.ready || Date.parse(current.recovery.expiresAt) <= now() || body.confirmed !== true || body.recoveryDigest !== current.recovery.digest || attemptedRecoveries.has(recoveryKey(current)))
          throw new Error("Explicitly confirm the exact fresh recovery inspection once");
        assertGripperRecoveryMatches(current, expected);
      }
      const revision2 = ++epoch;
      pending = kind;
      recoveryAvailable = false;
      recoveryReceivedAt = null;
      recoveryMessage = null;
      if (kind === "recoveryConfirm")
        attemptedRecoveries.add(recoveryKey(current));
      emit();
      try {
        let next;
        if (kind === "recoveryInspect") {
          const observed = assertGripperRecoveryMatches(await client.status(), expected);
          if (disposed || revision2 !== epoch || !canAct())
            return snapshot();
          recoveryRequestStatus = observed;
          if (gripperRecoveryCleared(observed, expected))
            next = observed;
          else {
            if (!observed.canInspectRecovery)
              throw new Error("This Node cannot inspect recovery for the retained trial");
            next = await client.recoveryInspect({ expectedNodeSessionId: observed.nodeSessionId, trialId: body.trialId, trialDigest: body.trialDigest });
          }
        } else {
          recoveryRequestStatus = current;
          next = await client.recoveryConfirm({ expectedNodeSessionId: current.nodeSessionId, ...body });
        }
        if (!disposed && revision2 === epoch)
          acceptRecovery(next, expected);
      } catch (error) {
        if (revision2 === epoch) {
          recoveryAvailable = false;
          recoveryReceivedAt = null;
          recoveryMessage = commissioningFailureMessage(error, "Recovery was not confirmed. The original outcome and ownership remain retained; inspect recovery status before continuing.");
          throw new Error(recoveryMessage);
        }
      } finally {
        pending = null;
        emit();
        schedule();
      }
      return snapshot();
    }
    if (pending || stopPending || !fresh() || !canAct())
      throw new Error("Refresh the connected gripper check and wait for the current operation before acting");
    let payload;
    if (kind === "inspect") {
      executionFields(body, []);
      if (!status.canInspect || active() || uncertain)
        throw new Error("Resolve the existing trial before inspecting the gripper");
      payload = { expectedNodeSessionId: status.nodeSessionId };
    } else if (kind === "prepare") {
      executionFields(body, ["configurationDigest", "inspectionDigest", "targetPosition"]);
      executionHash(body.configurationDigest);
      executionHash(body.inspectionDigest);
      const { configuration: c, inspection: i } = status, target2 = body.targetPosition;
      if (!status.canPrepare || active() || uncertain || !c || !i?.ready || Date.parse(i.expiresAt) <= now() || body.configurationDigest !== c.digest || body.inspectionDigest !== i.digest || typeof target2 !== "number" || !Number.isFinite(target2) || target2 < c.minimum || target2 > c.maximum || Math.abs(target2 - i.gripperPosition) > c.maximumDelta || Math.abs(target2 - i.gripperPosition) <= c.tolerance)
        throw new Error("Review a fresh inspection and an absolute target inside the configured gripper limits");
      payload = { expectedNodeSessionId: status.nodeSessionId, ...body };
    } else if (kind === "approve") {
      executionFields(body, ["trialId", "trialDigest", "approved"]);
      executionId(body.trialId);
      executionHash(body.trialDigest);
      if (attemptedApprovals.has(`${status.nodeSessionId}:${status.trial?.trialId}`) || !status.canApprove || status.trial?.phase !== "WAITING_FOR_APPROVAL" || status.trial.stopStatus !== null || uncertain || body.approved !== true || body.trialId !== status.trial.trialId || body.trialDigest !== status.trial.digest || Date.parse(status.trial.approvalExpiresAt) <= now())
        throw new Error("Explicitly approve the exact current unexpired gripper proposal");
      payload = { expectedNodeSessionId: status.nodeSessionId, ...body };
    } else
      throw new Error("Unsupported gripper check action");
    const revision = ++epoch;
    pending = kind;
    if (kind === "approve")
      attemptedApprovals.add(`${status.nodeSessionId}:${status.trial.trialId}`);
    emit();
    try {
      const next = await client[kind](payload);
      if (!disposed && revision === epoch)
        accept(next);
    } catch (error) {
      if (revision === epoch) {
        uncertain = kind === "approve" || kind === "prepare";
        invalidate(error, "The gripper request was not confirmed. Refresh the exact trial or request Stop; do not repeat the action.");
        throw new Error(message);
      }
    } finally {
      pending = null;
      emit();
      schedule();
    }
    return snapshot();
  }
  return {
    snapshot,
    action,
    refresh,
    invalidateRecovery,
    cancelRecovery,
    dispose() {
      disposed = true;
      ++epoch;
      clearTimeout(timer);
    }
  };
}

// ../harness-gripper-check/packages/cli/src/harness/workcell-controller.js
var WORKCELL_VIEW_VERSION = "physicalsystems-workcell-view-v1";
var WORKCELL_VIEW_MAX_BYTES = 256 * 1024;
var REQUEST_ERRORS = Object.freeze({
  agent_busy: [409, "Wait for the current agent request to finish before starting another request"],
  model_unavailable: [503, "Select a model in the Harness terminal before sending a request"],
  question_expired: [409, "This operator question is no longer current; use the current question in the terminal or browser"],
  camera_busy: [409, "Finish the current request before starting another camera preview; Stop remains available"],
  camera_changed: [409, "No matching current capture or pending Start is available; refresh camera state before retrying"],
  camera_unavailable: [503, "Camera preview is unavailable; refresh camera state and check the terminal"],
  camera_start_unconfirmed: [503, "Camera Start was not confirmed; refresh camera state and request Stop before starting another preview"],
  camera_stop_unconfirmed: [503, "Camera stop is not confirmed; retry Stop for this capture and check the terminal"],
  setup_busy: [409, "Setup inspection is already pending; wait for its result before retrying"],
  setup_unavailable: [503, "Setup inspection is unavailable; reopen /workcell from the Harness"],
  experiment_unavailable: [503, "Local experiments are unavailable; reopen this Harness conversation"]
});

class WorkcellRequestError extends Error {
  constructor(code) {
    super(REQUEST_ERRORS[code][1]);
    this.code = code;
  }
}
function workcellRequestFailure(error) {
  const entry = error instanceof WorkcellRequestError && REQUEST_ERRORS[error.code];
  return entry ? { status: entry[0], code: error.code, message: entry[1] } : null;
}
function displayText(value, maximum = 8000) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, maximum);
}
function inputText(value, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new TypeError("Enter a bounded, single-line physical outcome");
  return value.trim();
}
function createWorkcellController({
  workflow,
  refreshWorkflow,
  invalidateWorkflow = () => {},
  sendIntent,
  canPrompt = () => true,
  modelLabel = () => null,
  cameraClient,
  executionClient,
  commissioningClient,
  now = () => new Date().toISOString(),
  pollMs = 200,
  inspectSetup,
  getSetupView = () => ({ pending: false, report: null, error: null }),
  getExperiments = () => null,
  choiceTimeoutMs = 180000
} = {}) {
  const sessionId = randomUUID4();
  const listeners = new Set;
  let revision = 0;
  let disposed = false;
  let viewers = 0;
  let pollTimer = null;
  let cameraPending = null;
  let inventoryPending = null;
  let cameraActionPending = false;
  let cameraActionDone = null;
  let cameraStart = null;
  let cameraEpoch = 0;
  let startUnconfirmed = false;
  let stopCaptureSessionId = null;
  const ownedCaptureSessions = new Set;
  const stopRequestedSessions = new Set;
  const unconfirmedStops = new Set;
  const pendingStops = new Map;
  let disposePromise = null;
  let choice3 = null;
  let browserTurn = false;
  let pendingPrompt = null;
  let agent = { status: "idle", intent: null, reply: "", error: null, tool: null };
  let camera = { availability: "unchecked", status: null, frame: null, previewFrameId: null, error: null, receivedAt: null };
  let cachedFrame = null;
  const snapshot = () => {
    const base = {
      contractVersion: WORKCELL_VIEW_VERSION,
      sessionId,
      revision,
      physicalExecutionAuthorized: false,
      workflow,
      agent: {
        ...agent,
        model: displayText(modelLabel(), 160) || null,
        canPrompt: !disposed && agent.status !== "working" && canPrompt(),
        pendingChoice: choice3 ? { choiceId: choice3.id, kind: choice3.kind, question: choice3.question, options: choice3.options } : null
      },
      camera: {
        ...camera,
        pending: cameraActionPending ? "start" : null,
        stopPending: pendingStops.size > 0 || Boolean(cameraStart?.cancelled),
        stopUnconfirmed: unconfirmedStops.size > 0,
        stopCaptureSessionId: stopCaptureSessionId || ownedCaptureSessions.values().next().value || null
      },
      execution: execution.snapshot(),
      commissioning: commissioning.snapshot(),
      experiments: getExperiments()?.snapshot() || null
    };
    const setup = getSetupView();
    const result = { ...base, setup };
    if (Buffer.byteLength(JSON.stringify(result)) <= WORKCELL_VIEW_MAX_BYTES)
      return result;
    result.setup = {
      pending: setup.pending,
      report: null,
      historicalReport: null,
      error: "Setup details exceed this view’s remaining space. Use /physical-setup in the terminal for the bounded report."
    };
    return Buffer.byteLength(JSON.stringify(result)) <= WORKCELL_VIEW_MAX_BYTES ? result : base;
  };
  const emit = () => {
    if (disposed)
      return;
    revision += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const commissioning = createCommissioningController({
    client: commissioningClient,
    canAct: () => !disposed && agent.status !== "working" && !choice3 && !cameraActionPending && !pendingStops.size && !unconfirmedStops.size && !execution.snapshot().activeRuns.length && !execution.snapshot().pending,
    onChange: emit,
    now: () => Date.parse(now())
  });
  const execution = createExecutionController({
    client: executionClient,
    currentRoute: () => workflow?.routeReceipt,
    canPrepare: () => !commissioning.snapshot().unresolved && !commissioning.snapshot().pending && !disposed && agent.status !== "working" && !choice3 && !cameraActionPending && !pendingStops.size && !unconfirmedStops.size,
    onChange: emit,
    now: () => Date.parse(now())
  });
  const setWorkflow = (value) => {
    workflow = value;
    execution.contextChanged();
  };
  const resolveChoice = (answer) => {
    if (!choice3)
      return;
    const pending = choice3;
    choice3 = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.resolve(answer);
    emit();
  };
  const clearCameraFrame = () => {
    cachedFrame = null;
    camera = { ...camera, frame: null, previewFrameId: null };
  };
  function acceptStopped(status) {
    if (status.phase !== "stopped" || !status.captureSessionId)
      return;
    ownedCaptureSessions.delete(status.captureSessionId);
    unconfirmedStops.delete(status.captureSessionId);
    if (stopCaptureSessionId === status.captureSessionId)
      stopCaptureSessionId = null;
  }
  function stopCapture(sessionId2) {
    if (pendingStops.has(sessionId2))
      return pendingStops.get(sessionId2);
    const epoch = ++cameraEpoch;
    stopCaptureSessionId = sessionId2;
    stopRequestedSessions.add(sessionId2);
    clearCameraFrame();
    const request = Promise.resolve().then(() => cameraClient.stop({ expectedCaptureSessionId: sessionId2 })).then((status) => {
      if (status.captureSessionId !== sessionId2 || !["stopped", "stop-unconfirmed"].includes(status.phase))
        throw new Error("Invalid camera stop response");
      if (status.phase === "stopped")
        acceptStopped(status);
      else
        unconfirmedStops.add(sessionId2);
      if (cameraEpoch === epoch)
        camera = {
          ...camera,
          availability: "available",
          status: { ...status, availableCameras: camera.status?.availableCameras || [] },
          error: status.phase === "stopped" ? null : REQUEST_ERRORS.camera_stop_unconfirmed[1]
        };
      return status;
    }).catch(() => {
      unconfirmedStops.add(sessionId2);
      if (cameraEpoch === epoch)
        camera = {
          ...camera,
          availability: "unavailable",
          status: { ...camera.status, phase: "stop-unconfirmed", captureSessionId: sessionId2 },
          error: REQUEST_ERRORS.camera_stop_unconfirmed[1]
        };
      throw new WorkcellRequestError("camera_stop_unconfirmed");
    }).finally(() => {
      pendingStops.delete(sessionId2);
      emit();
    });
    pendingStops.set(sessionId2, request);
    emit();
    return request;
  }
  async function pollCamera() {
    if (disposed || cameraPending || cameraActionPending || pendingStops.size)
      return cameraPending;
    if (!cameraClient) {
      camera = { ...camera, availability: "unavailable", error: "Camera preview integration is unavailable", frame: null, previewFrameId: null };
      emit();
      return;
    }
    const epoch = cameraEpoch;
    cameraPending = (async () => {
      try {
        const packet = await cameraClient.frame();
        if (disposed || epoch !== cameraEpoch)
          return;
        const previousSession = camera.status?.captureSessionId;
        const previousPhase = camera.status?.phase;
        acceptStopped(packet.status);
        if (["idle", "stopped"].includes(packet.status.phase))
          startUnconfirmed = false;
        const stopUnconfirmed = stopRequestedSessions.has(packet.status.captureSessionId) && packet.status.phase !== "stopped";
        if (stopUnconfirmed) {
          unconfirmedStops.add(packet.status.captureSessionId);
          stopCaptureSessionId ||= packet.status.captureSessionId;
        }
        let frame = stopUnconfirmed ? null : packet.frame;
        let previewFrameId = null;
        if (frame) {
          const { jpegBytes, ...metadata } = frame;
          previewFrameId = createHash5("sha256").update(`${frame.captureSessionId}:${frame.sequence}:${frame.previewDigest}`).digest("hex");
          cachedFrame = { id: previewFrameId, bytes: jpegBytes, contentType: "image/jpeg" };
          frame = metadata;
        } else
          cachedFrame = null;
        camera = {
          availability: "available",
          status: {
            ...packet.status,
            ...stopUnconfirmed ? { phase: "stop-unconfirmed" } : {},
            availableCameras: packet.status.availableCameras ?? camera.status?.availableCameras ?? []
          },
          frame,
          previewFrameId,
          error: stopUnconfirmed ? REQUEST_ERRORS.camera_stop_unconfirmed[1] : null,
          receivedAt: now()
        };
        if (previousSession && previousSession !== packet.status.captureSessionId || previousPhase === "live" && packet.status.phase !== "live")
          invalidateWorkflow();
        emit();
      } catch (error) {
        if (disposed || epoch !== cameraEpoch)
          return;
        cachedFrame = null;
        if (camera.status?.phase === "live")
          invalidateWorkflow();
        camera = {
          ...camera,
          availability: "unavailable",
          frame: null,
          previewFrameId: null,
          error: displayText(safeErrorMessage(error), 350),
          receivedAt: now()
        };
        emit();
      }
    })().finally(() => {
      cameraPending = null;
    });
    return cameraPending;
  }
  async function refreshCameras() {
    if (disposed || !cameraClient?.status || inventoryPending)
      return inventoryPending;
    inventoryPending = (async () => {
      try {
        const status = await cameraClient.status();
        if (!disposed) {
          camera = { ...camera, status: { ...camera.status || status, availableCameras: status.availableCameras || [] } };
          emit();
        }
      } catch (error) {
        if (!disposed) {
          camera = { ...camera, error: displayText(safeErrorMessage(error), 350) };
          emit();
        }
      }
    })().finally(() => {
      inventoryPending = null;
    });
    return inventoryPending;
  }
  const schedule = () => {
    clearTimeout(pollTimer);
    if (disposed || !viewers)
      return;
    pollTimer = setTimeout(async () => {
      await pollCamera();
      schedule();
    }, pollMs);
    pollTimer.unref?.();
  };
  return {
    snapshot,
    setWorkflow,
    setupChanged: emit,
    experimentsChanged: emit,
    async experimentAction(kind, body) {
      if (disposed || !getExperiments())
        throw new WorkcellRequestError("experiment_unavailable");
      if (!["propose", "approve", "stop"].includes(kind))
        throw new TypeError("Unsupported local experiment action");
      await getExperiments()[kind](body);
      return snapshot();
    },
    async inspectSetup() {
      if (disposed || typeof inspectSetup !== "function")
        throw new WorkcellRequestError("setup_unavailable");
      if (getSetupView().pending)
        throw new WorkcellRequestError("setup_busy");
      await inspectSetup();
      return snapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onViewerConnect() {
      if (disposed)
        throw new Error("Harness session ended");
      viewers += 1;
      const leaveExecution = execution.connect();
      refreshCameras().then(pollCamera).then(schedule);
      let closed = false;
      return () => {
        if (closed)
          return;
        closed = true;
        leaveExecution();
        viewers = Math.max(0, viewers - 1);
        if (!viewers) {
          clearTimeout(pollTimer);
          resolveChoice(null);
        }
      };
    },
    async refresh() {
      if (disposed)
        throw new Error("Harness session ended");
      if (agent.status === "working")
        throw new WorkcellRequestError("agent_busy");
      await refreshWorkflow();
      await refreshCameras();
      await pollCamera();
      await execution.refresh();
      return snapshot();
    },
    async submitIntent(value) {
      const text3 = inputText(value);
      if (/^[!/]/.test(text3))
        throw new TypeError("Enter a physical outcome, not a terminal command");
      if (disposed)
        throw new Error("Harness session ended");
      if (agent.status === "working" || choice3)
        throw new WorkcellRequestError("agent_busy");
      if (!canPrompt())
        throw new WorkcellRequestError(displayText(modelLabel(), 160) ? "agent_busy" : "model_unavailable");
      browserTurn = true;
      agent = { status: "working", intent: text3, reply: "", error: null, tool: null };
      invalidateWorkflow("conversation");
      emit();
      const request = {};
      pendingPrompt = request;
      Promise.resolve().then(() => {
        if (disposed || pendingPrompt !== request)
          return;
        return sendIntent(text3);
      }).catch((error) => {
        if (disposed || pendingPrompt !== request)
          return;
        agent = { ...agent, status: "idle", error: displayText(safeErrorMessage(error), 350) };
        browserTurn = false;
        resolveChoice(null);
        emit();
      }).finally(() => {
        if (pendingPrompt === request)
          pendingPrompt = null;
      });
      return { accepted: true, physicalExecutionAuthorized: false };
    },
    agentStart(prompt) {
      agent = { status: "working", intent: displayText(prompt, 500), reply: "", error: null, tool: null };
      emit();
    },
    agentMessage(message) {
      if (message?.role !== "assistant")
        return;
      const text3 = Array.isArray(message.content) ? message.content.filter((item) => item.type === "text").map((item) => item.text).join(`
`) : "";
      agent = { ...agent, reply: displayText(text3), error: message.stopReason === "error" ? "The agent request failed; check the terminal for provider diagnostics." : null };
      emit();
    },
    agentTool(name) {
      agent = { ...agent, tool: displayText(name, 128) };
      emit();
    },
    agentSettled() {
      agent = { ...agent, status: "idle", tool: null };
      browserTurn = false;
      resolveChoice(null);
      emit();
    },
    modelChanged() {
      emit();
    },
    shouldAskInView() {
      return !disposed && browserTurn && viewers > 0;
    },
    ask({ kind, question, options = [], signal } = {}) {
      if (!["select", "input"].includes(kind))
        throw new TypeError("Unsupported operator question");
      if (disposed || !viewers || signal?.aborted)
        return Promise.resolve(null);
      if (choice3)
        throw new Error("An operator question is already pending");
      return new Promise((resolve2) => {
        const onAbort = () => resolveChoice(null);
        const timer = setTimeout(onAbort, choiceTimeoutMs);
        timer.unref?.();
        choice3 = {
          id: randomUUID4(),
          kind,
          question: displayText(question, 240),
          options: options.map((option) => displayText(option, 80)).slice(0, 7),
          resolve: resolve2,
          timer,
          signal,
          onAbort
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        emit();
      });
    },
    async answerChoice({ choiceId, answer }) {
      if (!choice3 || choice3.id !== choiceId)
        throw new WorkcellRequestError("question_expired");
      if (answer !== null) {
        answer = inputText(answer, 2000);
        if (choice3.kind === "select" && !choice3.options.includes(answer))
          throw new TypeError("Choose one of the displayed answers");
      }
      resolveChoice(answer);
      return { accepted: true, physicalExecutionAuthorized: false };
    },
    async cameraAction(action, body) {
      if (disposed || !cameraClient)
        throw new WorkcellRequestError("camera_unavailable");
      if (action === "stop") {
        const id3 = body?.expectedCaptureSessionId;
        if (id3 === null) {
          if (!cameraStart)
            throw new WorkcellRequestError("camera_changed");
          cameraStart.cancelled = true;
          cameraEpoch += 1;
          clearCameraFrame();
          invalidateWorkflow();
          emit();
          return snapshot();
        }
        if (typeof id3 !== "string" || !id3 || !ownedCaptureSessions.has(id3) && id3 !== camera.status?.captureSessionId && id3 !== stopCaptureSessionId)
          throw new WorkcellRequestError("camera_changed");
        if (cameraStart)
          cameraStart.cancelled = true;
        invalidateWorkflow();
        await stopCapture(id3);
        return snapshot();
      }
      if (action !== "start")
        throw new TypeError("Unsupported camera action");
      if (cameraActionPending || pendingStops.size || agent.status === "working")
        throw new WorkcellRequestError("camera_busy");
      if (unconfirmedStops.size || startUnconfirmed)
        throw new WorkcellRequestError("camera_stop_unconfirmed");
      if (ownedCaptureSessions.size || camera.status?.captureSessionId && !["idle", "stopped"].includes(camera.status.phase))
        throw new WorkcellRequestError("camera_busy");
      cameraActionPending = true;
      const start = { cancelled: false };
      cameraStart = start;
      cameraEpoch += 1;
      stopRequestedSessions.clear();
      let finishAction;
      const actionDone = new Promise((resolve2) => {
        finishAction = resolve2;
      });
      cameraActionDone = actionDone;
      emit();
      try {
        await cameraPending;
        if (!disposed && !start.cancelled) {
          invalidateWorkflow();
          clearCameraFrame();
          emit();
          let status;
          try {
            status = await cameraClient.start(body);
          } catch {
            startUnconfirmed = true;
            throw new WorkcellRequestError("camera_start_unconfirmed");
          }
          if (!status.captureSessionId) {
            startUnconfirmed = true;
            throw new WorkcellRequestError("camera_start_unconfirmed");
          }
          ownedCaptureSessions.add(status.captureSessionId);
          if (disposed || start.cancelled) {
            await stopCapture(status.captureSessionId);
          } else {
            camera = { ...camera, availability: "available", status: { ...status, availableCameras: camera.status?.availableCameras || [] }, error: null };
          }
        }
      } catch (error) {
        camera = { ...camera, error: workcellRequestFailure(error)?.message || REQUEST_ERRORS.camera_unavailable[1] };
        throw error;
      } finally {
        if (cameraStart === start)
          cameraStart = null;
        cameraActionPending = false;
        finishAction();
        if (cameraActionDone === actionDone)
          cameraActionDone = null;
        emit();
      }
      if (!disposed && !start.cancelled)
        pollCamera();
      return snapshot();
    },
    async cameraFrame(id3) {
      if (!cachedFrame || id3 !== cachedFrame.id)
        throw new Error("This exact preview frame is no longer retained; refresh the view");
      return { bytes: cachedFrame.bytes, contentType: cachedFrame.contentType };
    },
    async commissioningAction(action, body) {
      await commissioning.action(action, body);
      return snapshot();
    },
    async executionAction(action, body) {
      await execution.action(action, body);
      return snapshot();
    },
    async dispose() {
      if (disposePromise)
        return disposePromise;
      disposed = true;
      pendingPrompt = null;
      execution.dispose();
      commissioning.dispose();
      clearTimeout(pollTimer);
      resolveChoice(null);
      listeners.clear();
      cachedFrame = null;
      disposePromise = (async () => {
        await cameraActionDone;
        await Promise.allSettled([...pendingStops.values()]);
        for (const id3 of ownedCaptureSessions) {
          try {
            await stopCapture(id3);
          } catch {}
        }
      })();
      return disposePromise;
    }
  };
}
// ../harness-gripper-check/packages/cli/src/physical/setup-contracts.js
var SETUP_REQUIREMENTS_VERSION = "physicalsystems-setup-requirements-v1";
var SETUP_REQUIREMENTS_MAX_BYTES = 64 * 1024;
var SCOPES = [
  "registry-implementation",
  "implementation-artifact",
  "operating-conditions",
  "robot-calibration-artifact",
  "camera-calibration",
  "waypoint-catalog",
  "installed-source",
  "capture-source",
  "dependency-artifact",
  "qualification-record",
  "installed-configuration",
  "installed-dependency"
];
var KINDS = ["configuration", "registry", "binding", "driver", "calibration", "artifact", "qualification", "observation", "stop", "procedure"];
var STATES = ["present", "missing", "unverified", "failed", "stale"];
var SOURCES = ["registry", "installed-configuration", "provider-contract", "not-exposed"];
var EFFECTS = ["software-read-only", "hardware-validation", "operator-configuration"];
var DEPENDENCIES = ["lerobot", "tinyedge-runtime", "numpy", "opencv-python-headless", "pyserial", "feetech-servo-sdk"];
var OBSERVATIONS = {
  "maximum-source-exposure-age": "ns",
  "observation-maximum-age": "seconds",
  "capture-read-timeout": "ns",
  "capture-maximum-frame-age": "ns",
  "capture-exposure-timestamp-bound": "ns",
  "capture-width": "pixels",
  "capture-height": "pixels",
  "minimum-detection-score": "ratio",
  "maximum-validity": "ns"
};
var check2 = (value) => {
  if (!value)
    throw new TypeError("Setup response failed contract validation");
};
var choice3 = (value, choices) => {
  check2(choices.includes(value));
  return value;
};
var array4 = (value, maximum) => {
  check2(Array.isArray(value) && value.length <= maximum);
  return value;
};
var integer2 = (value) => {
  check2(Number.isSafeInteger(value) && value >= 0 && value <= 1e6);
  return value;
};
var unique2 = (values) => check2(new Set(values).size === values.length);
var nullable = (value, validate) => {
  if (value !== null)
    validate(value);
};
var id3 = (value) => check2(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value));
function timestamp3(value) {
  executionText(value, 64);
  check2(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
  return value;
}
function freeze3(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze3);
    Object.freeze(value);
  }
  return value;
}
function requirement2(value) {
  executionFields(value, ["requirementId", "kind", "label", "state", "reason", "evidence", "procedure"]);
  id3(value.requirementId);
  choice3(value.kind, KINDS);
  executionText(value.label, 120);
  executionText(value.reason, 360);
  choice3(value.state, STATES);
  executionFields(value.evidence, ["source", "sourceUpdatedAt", "mode"]);
  choice3(value.evidence.source, SOURCES);
  nullable(value.evidence.sourceUpdatedAt, timestamp3);
  choice3(value.evidence.mode, ["physical", "simulation", "unknown"]);
  if (value.evidence.source === "not-exposed") {
    check2(value.state === "unverified" && value.evidence.sourceUpdatedAt === null && value.evidence.mode === "unknown");
  }
  executionFields(value.procedure, ["procedureId", "label", "description", "effect", "requiresApproval"]);
  id3(value.procedure.procedureId);
  executionText(value.procedure.label, 120);
  executionText(value.procedure.description, 480);
  choice3(value.procedure.effect, EFFECTS);
  check2(typeof value.procedure.requiresApproval === "boolean");
  check2(value.procedure.requiresApproval === (value.procedure.effect !== "software-read-only"));
}
function constraint(value) {
  executionFields(value, ["kind", "name", "value", "unit", "source", "sourceUpdatedAt"]);
  choice3(value.kind, ["dependency-version", "observation-limit", "precondition", "precondition-age", "implementation-precondition", "implementation-precondition-age"]);
  id3(value.name);
  choice3(value.source, ["registry", "installed-configuration"]);
  nullable(value.sourceUpdatedAt, timestamp3);
  if (value.kind === "dependency-version") {
    choice3(value.name, DEPENDENCIES);
    check2(typeof value.value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,95}$/.test(value.value) && value.unit === null && value.source === "installed-configuration");
  } else if (["precondition", "implementation-precondition"].includes(value.kind)) {
    executionHash(value.value);
    check2(value.unit === null && value.source === "registry");
  } else if (["precondition-age", "implementation-precondition-age"].includes(value.kind)) {
    check2(Number.isSafeInteger(value.value) && value.value > 0 && value.value <= 300000000000 && value.unit === "ns" && value.source === "registry");
  } else {
    check2(Object.hasOwn(OBSERVATIONS, value.name) && value.unit === OBSERVATIONS[value.name] && value.source === "installed-configuration" && typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER);
    if (value.unit === "ns" || value.unit === "pixels" || value.unit === "count")
      check2(Number.isSafeInteger(value.value));
    if (value.unit === "ratio")
      check2(value.value <= 1);
  }
}
function implementation(value) {
  executionFields(value, ["provider", "capabilityId", "implementationId", "workcellId", "configurationId", "registeredImplementation", "profileStatus", "bindings", "requirements", "constraints"]);
  nullable(value.provider, (item) => choice3(item, ["so101-waypoints-v1"]));
  for (const name of ["capabilityId", "implementationId", "workcellId", "configurationId"])
    nullable(value[name], id3);
  check2(typeof value.registeredImplementation === "boolean" && value.registeredImplementation === (value.implementationId !== null));
  choice3(value.profileStatus, ["available", "unavailable"]);
  if (value.profileStatus === "available")
    check2(value.provider !== null);
  array4(value.bindings, 32).forEach((binding) => {
    executionFields(binding, ["scope", "id", "digest"]);
    choice3(binding.scope, SCOPES);
    id3(binding.id);
    executionHash(binding.digest);
  });
  unique2(value.bindings.map((binding) => `${binding.scope}:${binding.id}`));
  array4(value.requirements, 16).forEach(requirement2);
  unique2(value.requirements.map((item) => item.requirementId));
  array4(value.constraints, 32).forEach(constraint);
  unique2(value.constraints.map((item) => `${item.kind}:${item.name}`));
}
function normalizeSetupRequirements(value) {
  executionFields(value, [
    "contractVersion",
    "inspectedAt",
    "maximumAgeMs",
    "nodeSessionId",
    "registryDigest",
    "registryUpdatedAt",
    "mode",
    "inspectionOnly",
    "physicalExecutionAuthorized",
    "implementations",
    "truncation"
  ]);
  check2(value.contractVersion === SETUP_REQUIREMENTS_VERSION && value.inspectionOnly === true && value.physicalExecutionAuthorized === false);
  timestamp3(value.inspectedAt);
  check2(Number.isSafeInteger(value.maximumAgeMs) && value.maximumAgeMs > 0 && value.maximumAgeMs <= 30000);
  id3(value.nodeSessionId);
  nullable(value.registryDigest, executionHash);
  nullable(value.registryUpdatedAt, timestamp3);
  choice3(value.mode, ["discovery", "simulation", "physical"]);
  array4(value.implementations, 8).forEach(implementation);
  unique2(value.implementations.map((item) => JSON.stringify([item.provider, item.capabilityId, item.implementationId, item.workcellId, item.configurationId])));
  executionFields(value.truncation, ["implementationsOmitted", "requirementsOmitted", "bindingsOmitted", "constraintsOmitted"]);
  Object.values(value.truncation).forEach(integer2);
  check2(Buffer.byteLength(JSON.stringify(value)) <= SETUP_REQUIREMENTS_MAX_BYTES);
  return freeze3(value);
}

// ../harness-gripper-check/packages/cli/src/physical/setup-client.js
var PATH = "/v2/physical/setup/requirements";
var MAX_BYTES3 = 256 * 1024;
var MESSAGES = Object.freeze({
  unavailable: "Implementation setup inspection is unavailable; no missing equipment or physical readiness is inferred.",
  invalid: "Implementation setup evidence failed contract validation; no physical readiness is inferred."
});

class SetupReadError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
var setupReadFailure = (error) => error instanceof SetupReadError ? error.code : "unavailable";
async function readJson3(response) {
  if (response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new SetupReadError("invalid");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES3))
    throw new SetupReadError("invalid");
  const reader = response.body?.getReader?.();
  if (!reader)
    throw new SetupReadError("invalid");
  const chunks = [];
  let size = 0;
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > MAX_BYTES3)
        throw new SetupReadError("invalid");
      chunks.push(value);
    }
    try {
      return parseExecutionJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new SetupReadError("invalid");
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SetupReadError)
      throw error;
    throw new SetupReadError("unavailable");
  } finally {
    reader.releaseLock();
  }
}
function createSetupRequirementsClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl);
  return Object.freeze({
    async requirements() {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
        throw new SetupReadError("unavailable");
      let response;
      try {
        const url = new URL(PATH, origin);
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
        });
        if (response.redirected || response.type === "opaqueredirect" || response.url && response.url !== url.href)
          throw new SetupReadError("invalid");
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          if ([404, 501].includes(response.status))
            return Object.freeze({ status: "unsupported", report: null });
          throw new SetupReadError("unavailable");
        }
        const value = await readJson3(response);
        let report;
        try {
          report = normalizeSetupRequirements(value);
        } catch {
          throw new SetupReadError("invalid");
        }
        return Object.freeze({ status: "available", report });
      } catch (error) {
        if (error instanceof SetupReadError)
          throw error;
        throw new SetupReadError("unavailable");
      } finally {
        await response?.body?.cancel?.().catch(() => {});
      }
    }
  });
}

// ../harness-gripper-check/packages/cli/src/harness/setup-inspection.js
var MAX_AGE = 5000;
var MAX_ROWS = 32;
var MAX_IMPLEMENTATIONS = 16;
var MAX_REPORT_BYTES = 64 * 1024;
var ROUTE_KEYS = [
  "contractVersion",
  "runtimeVersion",
  "registrySnapshotDigest",
  "hostEvidenceDigest",
  "receiptDigest",
  "evaluatedAt",
  "observedAt",
  "evaluationMonotonicNs",
  "assessmentTimestamps",
  "policyVersion",
  "capabilityId",
  "workcellId",
  "request",
  "decision",
  "implementations",
  "physicalExecutionAuthorized"
];
var DECISION_KEYS = [
  "contract_version",
  "request_id",
  "request_digest",
  "catalog_digest",
  "policy_digest",
  "state_digest",
  "invocation_digest",
  "decision_status",
  "selected_implementation_id",
  "selected_implementation_digest",
  "selected_execution_target",
  "request_rejection_codes",
  "candidates",
  "physical_execution_authorized",
  "decision_digest"
];
var GROUPS = Object.freeze({
  implementation: ["implementation_blocked"],
  configuration: ["manifest_mismatch"],
  dependencies: ["dependency_missing", "dependency_mismatch"],
  calibration: ["calibration_missing", "calibration_mismatch"],
  artifacts: ["artifact_missing", "artifact_mismatch"],
  execution_target: ["execution_target_unavailable", "execution_target_mismatch"],
  state: [
    "precondition_missing",
    "precondition_unknown",
    "precondition_violated",
    "precondition_stale",
    "precondition_from_future",
    "precondition_invocation_mismatch",
    "precondition_state_mismatch",
    "precondition_requirement_mismatch"
  ],
  qualification: ["qualification_missing", "qualification_mismatch", "qualification_status_not_allowed"]
});
var ACTIONS = Object.freeze({
  implementation: "Ask the operator or implementation provider to inspect this exact implementation and the reported block. Do not select a fallback automatically.",
  configuration: "Review the exact capability and implementation configuration with the operator. Configuration changes require a separate approved setup step.",
  dependencies: "Ask the Node or implementation provider for the exact required drivers and dependency bindings, then verify their installed versions and health through an approved procedure.",
  calibration: "Ask for this implementation's exact calibration requirements and validation procedure. A matching hash or commissioned flag does not validate the physical calibration.",
  artifacts: "Ask for this implementation's exact required artifacts and validation procedure. Do not invent taught positions, paths, controller parameters or artifact bindings.",
  execution_target: "Have the operator verify the exact configured execution target and its connection through the supported setup procedure; do not dispatch a test command.",
  state: "Obtain fresh, trusted observations for the exact invocation through the supported observation source. Unknown, stale or violated state must remain blocked; do not open a camera automatically.",
  qualification: "Review the qualification record and its underlying evidence for this exact physical setup and policy. Simulation or a declared status does not qualify physical operation.",
  unclassified: "Ask the Node or implementation provider to explain the reported code. Do not infer a repair or bypass the block."
});
var LIMITATIONS = Object.freeze([
  "This is a read-only setup inventory and explanation of cached records. It does not establish current readiness, approval or permission to execute.",
  "The legacy capability and normalized route contracts do not expose exact per-implementation driver, calibration or artifact requirements. A separately available Node setup report describes its own declared requirements; unreported details remain unverified.",
  "Not exposed or unverified does not mean absent or missing. A missing claim requires an explicitly reported missing condition or a missing matching record in an available inventory.",
  "An implementation row's implementationDigest identifies a routing envelope; a configuration row's implementationDigest identifies an executable artifact. These digests have different scopes and need not match. Exact Node binding checks remain unchanged.",
  "Route decisions, qualification metadata and discovery observations describe their recorded context and times. A new inspection does not refresh those observations.",
  "Simulation configurations, route qualification labels, matching digests and discovery compatibility flags do not qualify physical operation.",
  "Preparation, approval, Stop, calibration and configuration changes remain in their existing operator-controlled workflows."
]);
var MESSAGES2 = Object.freeze({
  inspected: "Setup records inspected without refreshing discovery, routing, configuration or hardware.",
  partial: "Only part of the setup can be inspected from the available records. Resolve the listed evidence gaps; no readiness is assumed.",
  unavailable: "Setup evidence is unavailable. Check the local Node connection and obtain discovery and capability records; no missing hardware or calibration is inferred.",
  invalid_request: "Setup inspection accepts an empty object only. Do not supply paths, URLs, identifiers or execution actions.",
  inspection_busy: "A setup status read is still pending. No duplicate request was started; wait for it to settle.",
  inspection_timeout: "Setup status inspection timed out. No readiness is inferred; wait for the bounded read to settle before retrying.",
  inspection_cancelled: "Setup inspection was cancelled. No hardware or configuration action was requested.",
  context_changed: "The cached discovery, catalog or route context changed during inspection. Inspect again in the current context.",
  inspection_expired: "The setup inspection expired before completion. Inspect again; no current readiness is inferred.",
  disposed: "This setup inspection session has ended."
});
var check3 = (value) => {
  if (!value)
    throw new TypeError("Invalid cached setup contract");
};
var array5 = (value, maximum) => {
  check3(Array.isArray(value) && value.length <= maximum);
  return value;
};
var unique3 = (values) => check3(new Set(values).size === values.length);
var timestamp4 = (value) => {
  check3(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
  return value;
};
var reasonCodes = (value) => array5(value, 64).map(executionId);
var finding = (id4, status, message, action, codes = []) => ({ id: id4, status, reasonCodes: [...codes], message, action });
var target2 = (value) => {
  executionFields(value, ["kind", "digest"]);
  executionId(value.kind);
  executionHash(value.digest);
  return value;
};
function routeProjection(value) {
  executionFields(value, ROUTE_KEYS);
  check3(value.contractVersion === PHYSICAL_ROUTE_RECEIPT_VERSION && value.runtimeVersion === "0.2.0" && value.physicalExecutionAuthorized === false);
  for (const key of ["registrySnapshotDigest", "hostEvidenceDigest", "receiptDigest"])
    executionHash(value[key]);
  timestamp4(value.observedAt);
  timestamp4(value.evaluatedAt);
  const request = normalizePhysicalRouteRequest(value.request), decision2 = value.decision;
  check3(value.capabilityId === request.capabilityId && value.workcellId === request.workcellId);
  executionFields(decision2, DECISION_KEYS);
  check3(decision2.contract_version === "tinyedge-runtime-physical-skill-route-decision-v1" && decision2.physical_execution_authorized === false);
  executionId(decision2.request_id);
  for (const key of ["request_digest", "catalog_digest", "policy_digest", "state_digest", "invocation_digest", "decision_digest"])
    executionHash(decision2[key]);
  check3(executionDigest(decision2, "decision_digest") === decision2.decision_digest && decision2.catalog_digest === request.expectedCatalogDigest);
  check3(["selected", "no_match"].includes(decision2.decision_status));
  const codes = reasonCodes(decision2.request_rejection_codes);
  const candidates = array5(decision2.candidates, 512).map((item) => {
    executionFields(item, ["implementation_id", "implementation_digest", "mechanism", "provider", "execution_target", "status", "rejection_codes"]);
    executionId(item.implementation_id);
    executionHash(item.implementation_digest);
    executionId(item.mechanism);
    executionId(item.provider);
    target2(item.execution_target);
    check3(["selected", "eligible_not_selected", "rejected"].includes(item.status));
    reasonCodes(item.rejection_codes);
    check3(item.status === "rejected" === item.rejection_codes.length > 0);
    return item;
  });
  unique3(candidates.map((item) => item.implementation_id));
  const selected = candidates.filter((item) => item.status === "selected");
  if (decision2.decision_status === "selected") {
    check3(selected.length === 1 && !codes.length && decision2.selected_implementation_id === selected[0].implementation_id && decision2.selected_implementation_digest === selected[0].implementation_digest && executionDigest(target2(decision2.selected_execution_target)) === executionDigest(selected[0].execution_target));
  } else
    check3(!selected.length && decision2.selected_implementation_id === null && decision2.selected_implementation_digest === null && decision2.selected_execution_target === null && (codes.length || candidates.every((item) => item.status === "rejected")));
  const qualifications = array5(value.implementations, 512).map((item) => {
    executionFields(item, ["implementationId", "qualificationStatus"]);
    executionId(item.implementationId);
    check3(["qualified", "demo_qualified", "provisional", "blocked"].includes(item.qualificationStatus));
    return item;
  });
  unique3(qualifications.map((item) => item.implementationId));
  check3(qualifications.length === candidates.length && qualifications.every((item) => candidates.some((candidate) => candidate.implementation_id === item.implementationId)));
  return {
    request,
    decision: decision2,
    candidates,
    qualifications,
    receiptDigest: value.receiptDigest,
    capabilityId: request.capabilityId,
    workcellId: request.workcellId,
    observedAt: value.observedAt,
    evaluatedAt: value.evaluatedAt
  };
}
function discoveryProjection(value) {
  check3(["experimental-physical-candidates-v1", "experimental-physical-node-state-v1"].includes(value.contractVersion) && value.physicalExecutionAuthorized === false);
  executionHash(value.discoveryBindingDigest);
  executionHash(value.discovery.snapshotDigest);
  timestamp4(value.discovery.observedAt);
  const devices = array5(value.discovery.devices, 512).map((item) => {
    executionId(item.deviceId);
    check3(typeof item.detected === "boolean");
    if (item.adapterId != null)
      executionId(item.adapterId);
    if (item.adapterStatus != null)
      check3(["available", "unavailable", "setup-required"].includes(item.adapterStatus));
    return {
      deviceId: item.deviceId,
      adapterId: item.adapterId ?? null,
      presence: item.detected ? "observed" : "not_observed",
      adapterRegistration: item.adapterStatus === "available" ? "present" : item.adapterStatus === "unavailable" ? "missing" : "unverified",
      driverHealth: "unverified",
      calibration: "unverified",
      historical: true
    };
  });
  unique3(devices.map((item) => item.deviceId));
  return {
    devices,
    observedAt: value.discovery.observedAt,
    digest: value.discovery.snapshotDigest,
    partial: Boolean(array5(value.discovery.providerErrors ?? [], 64).length)
  };
}
function empty(code, status = "unavailable") {
  return {
    contractVersion: "physicalsystems-setup-inspection-v1",
    inspection: { status, reasonCode: code, observedAt: null, expiresAt: null, message: MESSAGES2[code] },
    service: { availability: "unavailable", mode: null, configurationInventory: "unverified" },
    sources: {
      discovery: { status: "unavailable", observedAt: null, digest: null, total: 0, shown: 0, truncated: false, historical: true },
      catalog: { status: "unavailable", observedAt: null, registryDigest: null, total: 0, shown: 0, truncated: false, historical: true },
      route: { status: "unavailable", receiptDigest: null, evaluatedAt: null, observedAt: null, capabilityId: null, workcellId: null, decisionStatus: null, relationship: "none", historical: true }
    },
    devices: [],
    capabilities: [],
    configurations: [],
    implementations: [],
    checks: [],
    requestBlockers: [],
    counts: { configurations: null, implementations: 0, configurationTruncated: false, implementationTruncated: false },
    implementationSetup: { status: "not_inspected", report: null },
    limitations: [...LIMITATIONS],
    physicalReadiness: "unverified",
    physicalExecutionAuthorized: false
  };
}
function requestBlocker(code) {
  if (["missing_argument", "unknown_argument", "argument_type_mismatch", "argument_out_of_bounds"].includes(code))
    return {
      code,
      message: "The route request has a missing, unknown or invalid typed input.",
      action: "Inspect the capability input schema and ask the operator for the missing or corrected argument. Do not guess a value."
    };
  if (["policy_incomplete", "policy_unknown_implementation"].includes(code))
    return {
      code,
      message: "The routing policy does not completely identify the intended implementations.",
      action: "Ask the Node or setup owner to review the exact routing policy. Do not reorder or select fallback implementations automatically."
    };
  if (["catalog_mismatch", "skill_definition_mismatch", "workcell_mismatch"].includes(code))
    return {
      code,
      message: "The route request no longer matches its catalog or workcell context.",
      action: "Obtain the current capability catalog and review a new route request before using its result."
    };
  if (code === "unknown_skill")
    return { code, message: "The requested capability is unsupported in the reported catalog.", action: "Inspect the supported capabilities and ask which supported outcome the operator intends." };
  return { code, message: "The Node reported an unclassified request blocker.", action: ACTIONS.unclassified };
}
function implementationProjection(candidate, route, service) {
  const metadata = route.qualifications.find((item) => item.implementationId === candidate.implementation_id);
  const installed = service?.availability === "available" ? service.configurations.filter((item) => item.capabilityId === route.capabilityId && item.implementationId === candidate.implementation_id) : null;
  const checks = Object.entries(GROUPS).map(([id4, codes]) => {
    const reported = candidate.rejection_codes.filter((code) => codes.includes(code));
    let status = "unverified", message = "Exact requirements and their validation evidence are not exposed by the public setup contracts. This does not mean they are absent or missing.";
    if (id4 === "implementation") {
      status = "present";
      message = "This implementation record is present in the cached route decision; current availability is not established.";
    }
    if (id4 === "qualification") {
      status = "present";
      message = "Qualification status metadata is present in the cached route record; underlying physical qualification evidence is not exposed. This does not mean it is absent or missing.";
    }
    if (id4 === "configuration") {
      status = installed === null ? "unverified" : installed.length ? "present" : "missing";
      message = installed === null ? "Configuration inventory is unavailable; no missing configuration is inferred." : installed.length ? "A configuration registration matches this capability and implementation ID. The implementation row's digest identifies a routing envelope; this configuration's implementation digest identifies an executable artifact. These digests need not match. Registration does not establish current readiness or verify calibration." : service.configurations.length ? "Installed configurations do not match this capability and implementation ID." : "No execution configurations were reported by the available status service.";
    }
    if (id4 === "state")
      message = "Fresh state and readiness have not been inspected. Cached routing observations cannot establish the current state.";
    if (id4 === "artifacts" && candidate.mechanism === "taught-waypoints")
      message = "The route names a taught-waypoints mechanism, but exact taught artifacts and their validation evidence are not exposed. This does not mean they are absent or missing.";
    if (reported.length) {
      status = reported.some((code) => code.endsWith("_missing") || code === "execution_target_unavailable") ? "missing" : "unverified";
      message = "The cached Node route reports the listed blockers for this implementation. Missing, mismatched, stale and policy-rejected evidence must be distinguished using those codes.";
    }
    return finding(id4, status, message, ACTIONS[id4], reported);
  });
  const unknown = candidate.rejection_codes.filter((code) => !Object.values(GROUPS).some((codes) => codes.includes(code)));
  if (unknown.length)
    checks.push(finding("unclassified", "unverified", "The Node reported additional implementation blockers whose meaning is not defined by this client.", ACTIONS.unclassified, unknown));
  return {
    capabilityId: route.capabilityId,
    implementationId: candidate.implementation_id,
    implementationDigest: candidate.implementation_digest,
    routingStatus: candidate.status,
    recordedQualificationStatus: metadata.qualificationStatus,
    mode: installed?.length ? service.mode : null,
    historical: true,
    checks
  };
}
function project(current, service, startedAt) {
  const result = empty("inspected", "available");
  result.inspection.observedAt = new Date(startedAt).toISOString();
  result.inspection.expiresAt = new Date(startedAt + MAX_AGE).toISOString();
  let discovery, catalog, route, partial = !service || service.availability !== "available";
  if (service) {
    result.service = {
      availability: service.availability,
      mode: service.mode,
      configurationInventory: service.availability === "available" ? "reported" : "unverified"
    };
    if (service.availability === "available") {
      result.counts.configurations = service.configurations.length;
      result.counts.configurationTruncated = service.configurations.length > MAX_ROWS;
    }
  }
  try {
    if (current.snapshot)
      discovery = discoveryProjection(current.snapshot);
  } catch {
    result.sources.discovery.status = "invalid";
  }
  if (discovery) {
    result.devices = discovery.devices.slice(0, MAX_ROWS);
    result.sources.discovery = {
      status: discovery.partial ? "partial" : "cached",
      observedAt: discovery.observedAt,
      digest: discovery.digest,
      total: discovery.devices.length,
      shown: result.devices.length,
      truncated: discovery.devices.length > MAX_ROWS,
      historical: true
    };
    partial ||= discovery.partial;
  } else
    partial = true;
  try {
    if (current.capabilityCatalog)
      catalog = normalizePhysicalCapabilityCatalog(current.capabilityCatalog);
  } catch {
    result.sources.catalog.status = "invalid";
  }
  if (catalog) {
    result.capabilities = catalog.capabilities.slice(0, MAX_ROWS).map((item) => ({
      capabilityId: item.capabilityId,
      availableForRouting: item.availableForRouting,
      preconditionCount: item.preconditions.length,
      reasonCodes: [...item.reasonCodes]
    }));
    result.sources.catalog = {
      status: "cached",
      observedAt: null,
      registryDigest: catalog.registryDigest,
      total: catalog.capabilities.length,
      shown: result.capabilities.length,
      truncated: catalog.capabilities.length > MAX_ROWS,
      historical: true
    };
  } else
    partial = true;
  try {
    if (current.routeReceipt) {
      check3(current.routeRelationship === undefined || ["current", "retired"].includes(current.routeRelationship));
      route = routeProjection(current.routeReceipt);
    }
  } catch {
    result.sources.route.status = "invalid";
  }
  if (route && catalog) {
    const workcell = catalog.workcells.find((item) => item.workcellId === route.workcellId);
    if (route.request.expectedRegistryDigest !== catalog.registryDigest || route.request.expectedCandidateBindingDigest !== catalog.currentCandidateBindingDigest || !catalog.capabilities.some((item) => item.capabilityId === route.capabilityId) || !workcell || workcell.workcellDigest !== route.request.expectedWorkcellDigest || workcell.catalogDigest !== route.request.expectedCatalogDigest) {
      route = null;
      result.sources.route.status = "context_mismatch";
    }
  }
  if (route) {
    result.sources.route = {
      status: "cached",
      receiptDigest: route.receiptDigest,
      evaluatedAt: route.evaluatedAt,
      observedAt: route.observedAt,
      capabilityId: route.capabilityId,
      workcellId: route.workcellId,
      decisionStatus: route.decision.decision_status,
      relationship: current.routeRelationship ?? "current",
      historical: true
    };
    result.requestBlockers = route.decision.request_rejection_codes.map(requestBlocker);
    result.counts.implementations = route.candidates.length;
    result.counts.implementationTruncated = route.candidates.length > MAX_IMPLEMENTATIONS;
    const candidates = [...route.candidates.filter((item) => item.status === "selected"), ...route.candidates.filter((item) => item.status !== "selected")];
    result.implementations = candidates.slice(0, MAX_IMPLEMENTATIONS).map((candidate) => implementationProjection(candidate, route, service));
  } else
    partial = true;
  if (service?.availability === "available") {
    const matchesSelected = (item) => route && item.capabilityId === route.capabilityId && item.implementationId === route.decision.selected_implementation_id;
    const configurations = [...service.configurations.filter(matchesSelected), ...service.configurations.filter((item) => !matchesSelected(item))];
    result.configurations = configurations.slice(0, MAX_ROWS).map(({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode: mode2 }) => ({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode: mode2 }));
  }
  result.checks = [
    finding("execution_service", service?.availability === "available" ? "present" : "unverified", "Execution status describes the reported service mode and configuration inventory, not physical readiness.", "Check the local Node connection and inspect the exact reported mode before reviewing a configuration."),
    finding("discovery", discovery ? "present" : "unverified", "Cached device discovery can report adapter registration; it does not test driver health or calibration.", "Obtain a discovery report if needed; opening cameras or testing hardware requires separate approval."),
    finding("capability_catalog", catalog ? "present" : "unverified", "Capability records declare supported inputs and common preconditions; they do not enumerate every implementation requirement.", "Inspect the local capability catalog and choose a supported capability without inventing requirements."),
    finding("route", route ? "present" : "unverified", result.sources.route.relationship === "retired" ? "These records belong to a previous proposal. They explain historical setup evidence; no current route or preparation eligibility is restored." : "Implementation comparisons are scoped to the cached route and retain the reported blockers for each displayed candidate.", "Obtain and review a current capability route for the intended typed invocation before operator preparation. Setup inspection cannot restore a retired proposal.")
  ];
  partial ||= result.counts.configurationTruncated || result.counts.implementationTruncated || result.sources.discovery.truncated || result.sources.catalog.truncated;
  if (partial) {
    const code = !service && !discovery && !catalog && !route ? "unavailable" : "partial";
    result.inspection.status = code;
    result.inspection.reasonCode = code;
    result.inspection.message = MESSAGES2[code];
  }
  return result;
}
function identity(value) {
  return [
    value.generation,
    value.snapshot,
    value.snapshot?.discoveryBindingDigest,
    value.capabilityCatalog,
    value.capabilityCatalog?.registryDigest,
    value.capabilityCatalog?.currentCandidateBindingDigest,
    value.routeReceipt,
    value.routeReceipt?.receiptDigest,
    value.routeReceipt?.decision?.decision_digest,
    value.routeRelationship
  ];
}
function implementationSetup(result, current, read, completedAt) {
  result.implementationSetup = { status: read.status, report: null };
  if (read.status !== "available")
    return;
  const report = read.report;
  const generated = Date.parse(report.inspectedAt);
  if (generated > completedAt || completedAt >= generated + report.maximumAgeMs) {
    result.implementationSetup.status = "expired";
    return;
  }
  const registry = result.sources.catalog.status === "cached" ? result.sources.catalog.registryDigest : result.sources.route.status === "cached" ? current.routeReceipt.request.expectedRegistryDigest : null;
  if (registry !== null && report.registryDigest !== registry || result.service.availability === "available" && report.mode !== "discovery" && report.mode !== result.service.mode) {
    result.implementationSetup.status = "context_mismatch";
    return;
  }
  const copy = structuredClone(report);
  const selected = current.routeReceipt?.decision?.selected_implementation_id;
  const selectedRow = (item) => result.sources.route.status === "cached" && item.registeredImplementation && item.implementationId === selected && item.capabilityId === result.sources.route.capabilityId && item.workcellId === result.sources.route.workcellId;
  copy.implementations = [...copy.implementations.filter(selectedRow), ...copy.implementations.filter((item) => !selectedRow(item))];
  result.implementationSetup.report = copy;
  result.inspection.expiresAt = new Date(Math.min(Date.parse(result.inspection.expiresAt), generated + report.maximumAgeMs)).toISOString();
  result.limitations.push("The Node setup report describes declared requirements and recorded metadata. Present does not mean physically validated. Registry or configuration source dates are not calibration validation or live observation times. Provider guidance without a registered implementation is not an installed implementation.", "Setup binding scopes are distinct: registry-implementation identifies the stored registry entry; routing-envelope and executable-artifact digests identify different records. Do not equate these hashes or infer execution readiness.");
}
function boundedReport(result) {
  let truncated = false;
  const provider = result.implementationSetup.report;
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_REPORT_BYTES) {
    truncated = true;
    if (result.implementations.length > 1) {
      result.implementations.pop();
      result.counts.implementationTruncated = true;
    } else if (provider?.implementations.length > 1) {
      const removed = provider.implementations.pop();
      provider.truncation.implementationsOmitted += 1;
      provider.truncation.requirementsOmitted += removed.requirements.length;
      provider.truncation.bindingsOmitted += removed.bindings.length;
      provider.truncation.constraintsOmitted += removed.constraints.length;
    } else if (result.configurations.length > 1) {
      result.configurations.pop();
      result.counts.configurationTruncated = true;
    } else if (result.devices.length) {
      result.devices.pop();
      result.sources.discovery.shown = result.devices.length;
      result.sources.discovery.truncated = true;
    } else if (result.capabilities.length) {
      result.capabilities.pop();
      result.sources.catalog.shown = result.capabilities.length;
      result.sources.catalog.truncated = true;
    } else if (provider?.implementations[0]?.requirements.length > 1) {
      provider.implementations[0].requirements.pop();
      provider.truncation.requirementsOmitted += 1;
    } else {
      return empty("unavailable");
    }
  }
  if (truncated || provider && Object.values(provider.truncation).some(Boolean) || !["available", "not_inspected"].includes(result.implementationSetup.status)) {
    if (result.inspection.status === "available") {
      result.inspection = { ...result.inspection, status: "partial", reasonCode: "partial", message: MESSAGES2.partial };
    }
  }
  return result;
}
function createSetupInspector({ client, requirementsClient, getContext = () => ({}), now = Date.now, readTimeoutMs = MAX_AGE } = {}) {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > MAX_AGE)
    throw new TypeError("Invalid setup inspection timeout");
  let disposed = false, pending = null;
  async function inspect(args = {}, { signal } = {}) {
    if (disposed)
      return empty("disposed", "disposed");
    if (signal?.aborted)
      return empty("inspection_cancelled");
    try {
      executionFields(args, []);
    } catch {
      return empty("invalid_request", "invalid_request");
    }
    if (pending)
      return empty("inspection_busy", "busy");
    let current, original;
    try {
      current = getContext() || {};
      original = identity(current);
    } catch {
      return empty("unavailable");
    }
    const startedAt = now(), attempt = { active: true, cancel: null, code: null };
    let timer;
    const fail2 = (code) => empty(code, code === "disposed" ? "disposed" : ["context_changed", "inspection_expired"].includes(code) ? "stale" : "unavailable");
    const guard = () => {
      if (disposed)
        throw "disposed";
      if (!attempt.active)
        throw attempt.code;
      const latest = identity(getContext() || {});
      if (original.some((value, index) => !Object.is(value, latest[index])))
        throw "context_changed";
      if (now() < startedAt || now() - startedAt >= MAX_AGE)
        throw "inspection_expired";
    };
    const interrupted = new Promise((resolve2) => {
      attempt.cancel = (code) => {
        if (attempt.active) {
          attempt.active = false;
          attempt.code = code;
          clearTimeout(timer);
          resolve2(fail2(code));
        }
      };
    });
    pending = attempt;
    timer = setTimeout(() => attempt.cancel("inspection_timeout"), readTimeoutMs);
    const abort = () => attempt.cancel("inspection_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const work = (async () => {
      try {
        guard();
        const [service, requirements] = await Promise.all([
          (async () => {
            try {
              return client ? normalizeExecutionStatus(await client.status()) : null;
            } catch {
              return null;
            }
          })(),
          (async () => {
            if (!requirementsClient)
              return { status: "not_inspected", report: null };
            let read;
            try {
              read = await requirementsClient.requirements();
            } catch (error) {
              return { status: setupReadFailure(error), report: null };
            }
            try {
              executionFields(read, ["status", "report"]);
              if (read.status === "unsupported" && read.report === null)
                return read;
              check3(read.status === "available");
              return { status: "available", report: normalizeSetupRequirements(read.report) };
            } catch {
              return { status: "invalid", report: null };
            }
          })()
        ]);
        guard();
        const result = project(current, service, startedAt);
        implementationSetup(result, current, requirements, now());
        guard();
        return boundedReport(result);
      } catch (code) {
        return fail2(Object.hasOwn(MESSAGES2, code) ? code : "unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (pending === attempt)
          pending = null;
      }
    })();
    return Promise.race([work, interrupted]);
  }
  return Object.freeze({ inspect, dispose() {
    disposed = true;
    pending?.cancel("disposed");
  } });
}
// ../harness-gripper-check/packages/cli/src/harness/setup-view.js
function createSetupView({ inspector, getContext, onChange = () => {}, now = Date.now } = {}) {
  let disposed = false;
  let active = null;
  let expiry = null;
  let report = null;
  let historicalReport = null;
  let error = null;
  let acceptedAt = null;
  function clear() {
    clearTimeout(expiry);
    expiry = null;
    report = null;
    historicalReport = null;
    error = null;
  }
  function expire() {
    if (!report)
      return;
    const remaining = Date.parse(report.inspection.expiresAt) - now();
    if (!Number.isFinite(remaining) || remaining <= 0 || now() < acceptedAt) {
      const previous = report;
      clear();
      historicalReport = previous;
      error = "Setup report expired. Historical guidance is retained; inspect setup again for current evidence.";
      onChange();
    }
  }
  return Object.freeze({
    snapshot() {
      expire();
      return { pending: active !== null, report, historicalReport, error };
    },
    contextChanged() {
      clear();
      if (!disposed)
        onChange();
    },
    async inspect(args = {}, { signal } = {}) {
      if (disposed || active)
        return inspector.inspect(args, { signal });
      const request = { context: getContext(), controller: new AbortController };
      active = request;
      clear();
      onChange();
      try {
        const result = await inspector.inspect(args, {
          signal: signal ? AbortSignal.any([signal, request.controller.signal]) : request.controller.signal
        });
        if (!disposed && active === request && request.context === getContext() && !request.controller.signal.aborted && !signal?.aborted) {
          report = result;
          acceptedAt = now();
          if (result.inspection.expiresAt) {
            expire();
            if (report) {
              expiry = setTimeout(expire, Math.max(0, Date.parse(result.inspection.expiresAt) - now()));
              expiry.unref?.();
            }
          }
        }
        return result;
      } catch (cause) {
        if (!disposed && request.context === getContext() && !request.controller.signal.aborted) {
          error = "Setup inspection could not be completed. Retry Inspect setup.";
        }
        throw cause;
      } finally {
        if (active === request)
          active = null;
        if (!disposed)
          onChange();
      }
    },
    dispose() {
      disposed = true;
      inspector.dispose();
      active?.controller.abort();
      clear();
    }
  });
}
// ../harness-gripper-check/packages/cli/src/harness/execution-inspection.js
var MAX_READ_AGE2 = 5000;
var MAX_KNOWN_RUNS = 128;
var PIN_IDS = ["capabilityId", "implementationId", "configurationId"];
var PIN_DIGESTS = ["implementationDigest", "configurationDigest", "routeReceiptDigest", "snapshotDigest"];
var MESSAGES3 = Object.freeze({
  inspected: "Read-only execution records inspected. A recorded result is historical evidence, not current readiness or permission to execute.",
  execution_unavailable: "Execution inspection is unavailable. No run outcome is inferred. Check the local Node connection and use /workcell to inspect the operator view.",
  inspection_timeout: "Execution inspection timed out. No run outcome is inferred. Wait for the bounded read to settle, then inspect again.",
  inspection_cancelled: "Execution inspection was cancelled. No run outcome is inferred and no execution action was requested.",
  context_changed: "The session, route or selected run changed during inspection. Inspect again in the current context; no result from the retired context is used.",
  inspection_expired: "Execution inspection expired before it completed. Inspect again; no current state or run outcome is inferred.",
  selection_required: "Several known runs exist. Ask which exact listed run to inspect, or select it in /workcell. Do not assume the newest run belongs to this task.",
  invalid_request: "Inspect with no arguments, or with an exact runId previously returned by this tool or currently selected in /workcell. Paths, URLs and execution actions are not accepted.",
  inspection_busy: "An execution inspection read is still pending. No duplicate read or execution action was started. Wait for it to settle before trying again.",
  disposed: "This execution inspection session has ended. No read or execution action was started.",
  run_context_mismatch: "The execution mode or exact run identity changed or failed validation. Inspect the current operator view; no matching result is assumed."
});
var CONFIGURATION_MESSAGES = Object.freeze({
  matching: "Matching installed configurations are available to review in /workcell. Installation and route selection do not establish current readiness or approval. Node preparation performs the exact checks.",
  missing_route: "Obtain a successful capability route to identify matching installed configurations. A route does not authorize preparation or execution.",
  missing_configuration: "No installed configuration matches the selected capability and implementation. The operator must configure and qualify the intended setup before preparation can succeed.",
  unavailable: "Configuration availability could not be inspected. Check the local Node connection in /workcell; no readiness is assumed."
});

class InspectionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function check4(condition) {
  if (!condition)
    throw new InspectionFailure("run_context_mismatch");
}
async function joined(reads) {
  const results = await Promise.allSettled(reads);
  const failure2 = results.find((result) => result.status === "rejected");
  if (failure2)
    throw failure2.reason;
  return results.map((result) => result.value);
}
function pinRun(run) {
  executionRunId(run.runId);
  check4(["simulation", "physical"].includes(run.mode));
  const pinned = { runId: run.runId, mode: run.mode };
  for (const key of PIN_IDS)
    pinned[key] = executionId(run[key]);
  for (const key of PIN_DIGESTS)
    pinned[key] = executionHash(run[key]);
  check4(Number.isSafeInteger(run.revision) && run.revision >= 0);
  pinned.revision = run.revision;
  pinned.runDigest = executionHash(run.runDigest);
  return pinned;
}
function matchPins(run, expected) {
  const { revision, runDigest, eventDigests, inputsDigest, approvalDigest, approvalExpiresAt, ...pins } = expected;
  assertRunMatches(run, pins);
  check4(run.revision >= revision && (run.revision !== revision || run.runDigest === runDigest));
  if (eventDigests) {
    check4(run.events.length >= eventDigests.length);
    eventDigests.forEach((digest3, index) => check4(executionDigest(run.events[index]) === digest3));
    check4(executionDigest(run.inputs) === inputsDigest && run.approval.digest === approvalDigest && run.approval.expiresAt === approvalExpiresAt);
  }
  return run;
}
function rememberRun(run) {
  return {
    ...pinRun(run),
    eventDigests: run.events.map((event) => executionDigest(event)),
    inputsDigest: executionDigest(run.inputs),
    approvalDigest: run.approval.digest,
    approvalExpiresAt: run.approval.expiresAt
  };
}
function projectRoute(value) {
  if (value?.decision?.decision_status !== "selected" || value.physicalExecutionAuthorized !== false)
    return null;
  return {
    receiptDigest: executionHash(value.receiptDigest),
    capabilityId: executionId(value.capabilityId),
    implementationId: executionId(value.decision.selected_implementation_id)
  };
}
function summary3(run) {
  return {
    ...pinRun(run),
    phase: run.phase,
    stopStatus: run.stopStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outcomeStatus: run.outcome?.status ?? null,
    historical: true
  };
}
function receiptUnavailable(status = "not_requested") {
  return {
    status,
    historical: true,
    receiptDigest: null,
    runId: null,
    runDigest: null,
    snapshotDigest: null,
    configurationSnapshotDigest: null,
    evidenceDigest: null,
    preparation: null,
    verification: null,
    message: status === "unavailable" ? "The recorded run phase is available, but its receipt and referenced evidence could not be verified. Do not claim a verified result or infer a different Node outcome." : "No receipt has been inspected."
  };
}
function base(code, status = "unavailable") {
  return {
    contractVersion: "physicalsystems-execution-inspection-v1",
    inspection: { status, observedAt: null, expiresAt: null, reasonCode: code, message: MESSAGES3[code] },
    service: { availability: "unavailable", mode: null },
    route: null,
    configurationAvailability: {
      status: "unavailable",
      matchingConfigurations: [],
      installedCount: null,
      message: CONFIGURATION_MESSAGES.unavailable
    },
    runs: [],
    selectedRun: null,
    receipt: receiptUnavailable(),
    operatorPath: "/workcell",
    physicalExecutionAuthorized: false
  };
}
function createExecutionInspector({ client, getContext = () => ({}), now = Date.now, readTimeoutMs = MAX_READ_AGE2 } = {}) {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > MAX_READ_AGE2)
    throw new TypeError("Invalid execution inspection timeout");
  let disposed = false, pending = null;
  const known = new Map;
  const context = () => {
    const value = getContext() || {};
    return { generation: value.generation, route: projectRoute(value.route), selectedRun: value.selectedRun ? pinRun(value.selectedRun) : null };
  };
  async function inspect(args = {}, { signal } = {}) {
    if (disposed)
      return base("disposed", "disposed");
    if (signal?.aborted)
      return base("inspection_cancelled");
    let initial, requested;
    try {
      check4(args && typeof args === "object" && !Array.isArray(args));
      const keys = Object.keys(args);
      check4(keys.length === 0 || keys.length === 1 && keys[0] === "runId");
      initial = context();
      if (keys.length) {
        requested = executionRunId(args.runId);
        check4(known.has(requested) || initial.selectedRun?.runId === requested);
      }
    } catch {
      return base("invalid_request", "invalid_request");
    }
    if (pending)
      return base("inspection_busy", "busy");
    if (!client)
      return base("execution_unavailable");
    const startedAt = now(), attempt = { active: true, code: null, cancel: null };
    let timer, abort;
    const failure2 = (code) => base(code, code === "disposed" ? "disposed" : ["context_changed", "inspection_expired"].includes(code) ? "stale" : "unavailable");
    const guard = (run = null) => {
      if (disposed)
        throw new InspectionFailure("disposed");
      if (!attempt.active)
        throw new InspectionFailure(attempt.code);
      const current = context();
      if (!Object.is(current.generation, initial.generation) || current.route?.receiptDigest !== initial.route?.receiptDigest || current.selectedRun?.runId !== initial.selectedRun?.runId)
        throw new InspectionFailure("context_changed");
      if (now() < startedAt || now() - startedAt >= MAX_READ_AGE2)
        throw new InspectionFailure("inspection_expired");
      if (run && current.selectedRun?.runId === run.runId)
        matchPins(run, current.selectedRun);
    };
    const interrupted = new Promise((resolve2) => {
      attempt.cancel = (code) => {
        if (!attempt.active)
          return;
        attempt.active = false;
        attempt.code = code;
        clearTimeout(timer);
        resolve2(failure2(code));
      };
    });
    pending = attempt;
    timer = setTimeout(() => attempt.cancel("inspection_timeout"), readTimeoutMs);
    abort = () => attempt.cancel("inspection_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const work = (async () => {
      try {
        guard();
        const [statusValue, listValue] = await joined([client.status(), client.runs()]);
        guard();
        const status = normalizeExecutionStatus(statusValue), listing = normalizePhysicalRunList(listValue);
        if (status.availability !== "available")
          return base("execution_unavailable");
        for (const run of listing.runs) {
          check4(run.mode === status.mode);
          if (known.has(run.runId))
            matchPins(run, known.get(run.runId));
          if (initial.selectedRun?.runId === run.runId)
            matchPins(run, initial.selectedRun);
        }
        const result = base("inspected", "available");
        result.inspection.observedAt = new Date(startedAt).toISOString();
        result.inspection.expiresAt = new Date(startedAt + MAX_READ_AGE2).toISOString();
        result.service = { availability: status.availability, mode: status.mode };
        result.route = initial.route;
        const matching = initial.route ? status.configurations.filter((item) => item.capabilityId === initial.route.capabilityId && item.implementationId === initial.route.implementationId) : [];
        const configurationStatus = !initial.route ? "missing_route" : matching.length ? "matching" : "missing_configuration";
        result.configurationAvailability = {
          status: configurationStatus,
          installedCount: status.configurations.length,
          matchingConfigurations: matching.slice(0, 32).map(({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode: mode2 }) => ({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode: mode2 })),
          message: CONFIGURATION_MESSAGES[configurationStatus]
        };
        result.runs = listing.runs.map(summary3);
        const selectedId = requested || initial.selectedRun?.runId || (listing.runs.length === 1 ? listing.runs[0].runId : null);
        if (!selectedId && listing.runs.length > 1) {
          result.inspection.status = "selection_required";
          result.inspection.reasonCode = "selection_required";
          result.inspection.message = MESSAGES3.selection_required;
        }
        let selected = null;
        if (selectedId) {
          const listed = listing.runs.find((item) => item.runId === selectedId);
          const expected = listed ? rememberRun(listed) : initial.selectedRun?.runId === selectedId ? initial.selectedRun : known.get(selectedId);
          check4(expected);
          const { revision, runDigest, ...immutablePins } = pinRun(expected);
          const value = await client.run(selectedId, immutablePins);
          guard();
          selected = matchPins(normalizePhysicalRun(value), expected);
          if (known.has(selectedId))
            matchPins(selected, known.get(selectedId));
          check4(selected.mode === status.mode);
          guard(selected);
          try {
            const receipt = normalizePhysicalRunReceipt(await client.receipt(selectedId, selected), selected);
            guard(receipt.run);
            const { snapshot, run: recordedRun } = receipt;
            selected = recordedRun;
            check4(snapshot.contractVersion === "physicalsystems-run-snapshot-v1");
            check4(snapshot.configurationId === recordedRun.configurationId && snapshot.configurationSnapshotDigest === recordedRun.configurationDigest);
            check4(snapshot.prepared && snapshot.prepared.mode === recordedRun.mode);
            for (const key of ["capabilityId", "implementationId", "implementationDigest", "configurationDigest"])
              check4(snapshot.prepared[key] === recordedRun[key]);
            check4(executionDigest(snapshot.prepared.inputs) === executionDigest(recordedRun.inputs));
            const configurationDigest = executionHash(snapshot.configurationSnapshotDigest);
            const evidenceDigest = recordedRun.outcome?.evidenceDigest;
            const [configurationValue, evidenceValue] = await joined([
              client.snapshot(configurationDigest),
              evidenceDigest ? client.snapshot(evidenceDigest) : null
            ]);
            guard(recordedRun);
            const configuration = normalizeExecutionSnapshot(configurationValue, configurationDigest);
            const evidence = evidenceDigest ? normalizeExecutionSnapshot(evidenceValue, evidenceDigest) : null;
            const preparation = projectExecutionObservation(snapshot.preparationObservation, { stage: "preparation", at: recordedRun.createdAt, mode: recordedRun.mode });
            const verification = projectExecutionObservation(evidence?.snapshot, { stage: "verification", at: recordedRun.updatedAt, mode: recordedRun.mode });
            check4(preparation && (!evidenceDigest || verification));
            if (recordedRun.phase === "VERIFIED_SUCCESS")
              check4(verification?.verified === "met");
            result.receipt = {
              status: "verified",
              historical: true,
              receiptDigest: receipt.receiptDigest,
              runId: selected.runId,
              runDigest: selected.runDigest,
              snapshotDigest: selected.snapshotDigest,
              configurationSnapshotDigest: configuration.snapshotDigest,
              evidenceDigest: evidence?.snapshotDigest ?? null,
              preparation,
              verification,
              message: "Receipt and referenced snapshots passed integrity and exact run checks. Observations describe their recorded times, not current readiness. Receipt verification does not change the recorded outcome."
            };
          } catch (error) {
            guard(selected);
            result.receipt = receiptUnavailable("unavailable");
          }
          const installed = status.configurations.find((item) => item.configurationId === selected.configurationId);
          result.selectedRun = {
            ...summary3(selected),
            currentConfiguration: !installed ? "not_installed" : ["mode", "capabilityId", "implementationId", "implementationDigest", "configurationDigest"].every((key) => selected[key] === installed[key]) ? "exact" : "changed",
            routeRelationship: !initial.route ? "no_route" : initial.route.receiptDigest === selected.routeReceiptDigest ? "current" : "historical"
          };
          result.runs = [summary3(selected), ...result.runs.filter((run) => run.runId !== selected.runId)].slice(0, 32);
        }
        guard(selected);
        for (const run of result.runs) {
          const record = run.runId === selected?.runId ? selected : listing.runs.find((item) => item.runId === run.runId);
          known.delete(run.runId);
          known.set(run.runId, rememberRun(record));
        }
        while (known.size > MAX_KNOWN_RUNS)
          known.delete(known.keys().next().value);
        return result;
      } catch (error) {
        return failure2(error instanceof InspectionFailure ? error.code : "execution_unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (pending === attempt)
          pending = null;
      }
    })();
    return Promise.race([work, interrupted]);
  }
  return Object.freeze({ inspect, dispose() {
    disposed = true;
    known.clear();
    pending?.cancel("disposed");
  } });
}
// ../harness-gripper-check/packages/cli/src/harness/agent-skills.js
import { createHash as createHash6 } from "node:crypto";
import {
  closeSync as closeSync2,
  constants as constants2,
  fstatSync,
  lstatSync as lstatSync2,
  openSync as openSync2,
  readSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var READ_AGENT_SKILL_TOOL = "read_agent_skill";
var PACKAGE_ROOT = fileURLToPath(new URL("./skills/", import.meta.url));
var PACKAGE_FILES = Object.freeze(["SKILL.md", "physicalsystems.binding.json"]);
var MAX_PACKAGE_FILE_BYTES = 16 * 1024;
var PACKAGES = Object.freeze([
  Object.freeze({
    id: "inspect-workcell",
    description: "Inspect connected hardware, guide operator camera preview through /workcell, and explain observed candidates, adapter availability, commissioning gaps, and physical capability readiness without moving hardware.",
    capabilities: Object.freeze([]),
    skillHash: "30979cb867b4be682d9748c22392af5d1799aa902eae5e89c339b0a2df4614d6",
    bindingHash: "b5ed7dff14e9d1808dfe1d43734274c6c9faeacd3b1024f3b6f952a707a0d4f8"
  }),
  Object.freeze({
    id: "transfer-container",
    description: "Prepare a container transfer by inspecting the workcell, clarifying the operator's intent, and requesting a typed physical capability route preview with current node evidence.",
    capabilities: Object.freeze(["transfer-container"]),
    skillHash: "aba324cf88db6c1ceb47fe162cd71039f164a511aec4fe12703479f996b609c2",
    bindingHash: "d800b6b2ad058a9c674cd33147f27ac91a3e77c22918389f6d50db604138f4c2"
  })
]);
var CURATED_AGENT_SKILL_IDS = Object.freeze(PACKAGES.map(({ id: id4 }) => id4));
function fail2(reason) {
  throw new Error(`Bundled Agent Skill rejected: ${reason}`);
}
function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string")
    return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function checkedDirectory(directory, expectedEntries) {
  const stat = lstatSync2(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(directory), directory))
    fail2("redirected package directory");
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...expectedEntries].sort())) {
    fail2("unexpected package entries");
  }
}
function readPinnedFile(filePath, expectedHash) {
  const initial = lstatSync2(filePath);
  if (!initial.isFile() || initial.isSymbolicLink() || !samePath(realpathSync(filePath), filePath))
    fail2("redirected package file");
  const fd = openSync2(filePath, constants2.O_RDONLY | (constants2.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size > MAX_PACKAGE_FILE_BYTES)
      fail2("invalid package file");
    const buffer = Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const received = readSync(fd, buffer, length, buffer.length - length, null);
      if (!received)
        break;
      length += received;
    }
    if (length > MAX_PACKAGE_FILE_BYTES || length !== opened.size)
      fail2("invalid package size");
    const contents = buffer.subarray(0, length);
    if (createHash6("sha256").update(contents).digest("hex") !== expectedHash) {
      fail2("package integrity mismatch");
    }
    return contents.toString("utf8");
  } finally {
    closeSync2(fd);
  }
}
function readPackage(root, entry) {
  checkedDirectory(root, CURATED_AGENT_SKILL_IDS);
  const directory = path.join(root, entry.id);
  checkedDirectory(directory, PACKAGE_FILES);
  const instructions = readPinnedFile(path.join(directory, "SKILL.md"), entry.skillHash);
  const rawBinding = readPinnedFile(path.join(directory, "physicalsystems.binding.json"), entry.bindingHash);
  const binding = JSON.parse(rawBinding);
  if (JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(["capabilities", "schemaVersion", "skill"]) || binding.schemaVersion !== 1 || binding.skill !== entry.id || JSON.stringify(binding.capabilities) !== JSON.stringify(entry.capabilities)) {
    fail2("invalid portable binding");
  }
  return { directory, instructions, binding };
}
function loadVerifiedAgentSkills({ packageRoot = PACKAGE_ROOT } = {}) {
  const root = path.resolve(packageRoot);
  for (const entry of PACKAGES)
    readPackage(root, entry);
  return verifiedRegistry(root, PACKAGES.map(({ id: id4, description }) => Object.freeze({ skillId: id4, description })));
}
function verifiedRegistry(root, summaries) {
  return Object.freeze({
    summaries: Object.freeze(summaries),
    prompt() {
      return [
        "Reviewed Agent Skills (instruction packages, not hardware capabilities):",
        `When a task matches, call ${READ_AGENT_SKILL_TOOL} with its exact skillId to read its instructions.`,
        ...summaries.map(({ skillId, description }) => `- ${skillId}: ${description}`),
        "An Agent Skill is SKILL.md guidance. A physical capability is a typed operation; a capability implementation is a controller or policy.",
        "Reading a package grants no tools, permissions, readiness, physical evidence, or execution authority.",
        "Portable bindings describe relevance only; query the local node for actual capability availability and exact IDs.",
        "Arbitrary local skills, file reads, scripts, and shell commands are disabled. Use only the granted tools."
      ].join(`
`);
    },
    read(skillId) {
      const entry = PACKAGES.find(({ id: id4 }) => id4 === skillId);
      if (!entry)
        fail2("unknown Agent Skill id");
      const { instructions, binding } = readPackage(root, entry);
      return {
        kind: "agent-skill-instructions",
        source: "bundled-reviewed-package",
        skillId: entry.id,
        description: entry.description,
        binding,
        instructions,
        permissionsGranted: [],
        physicalExecutionAuthorized: false
      };
    }
  });
}
function createReadAgentSkillTool({ registry, defineTool = (definition) => definition }) {
  return defineTool({
    name: READ_AGENT_SKILL_TOOL,
    label: "Read Agent Skill",
    description: "Read one reviewed, bundled Agent Skill instruction package by exact ID. No arbitrary paths or files; never grants tools, device readiness, or execution authority.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skillId"],
      properties: { skillId: { type: "string", enum: [...CURATED_AGENT_SKILL_IDS] } }
    },
    async execute(_toolCallId, params) {
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1 || !Object.hasOwn(params, "skillId") || typeof params.skillId !== "string")
        fail2("expected only an exact skillId");
      const payload = registry.read(params.skillId);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: { displaySummary: `Read Agent Skill: ${payload.skillId}` }
      };
    }
  });
}

// ../harness-gripper-check/packages/cli/src/physical/workflow-core.js
var PHYSICAL_DISCOVERY_TOOL = "inspect_physical_system";
var PHYSICAL_INTENT_TOOL = "plan_physical_workflow";
var PHYSICAL_CAPABILITIES_TOOL = "inspect_physical_capabilities";
var PHYSICAL_ROUTE_TOOL = "preview_physical_capability";
var PHYSICAL_EXECUTION_INSPECTION_TOOL = "inspect_physical_execution";
var PHYSICAL_SETUP_INSPECTION_TOOL = "inspect_physical_setup";
var PHYSICAL_TOOL_ALLOWLIST = Object.freeze([
  PHYSICAL_DISCOVERY_TOOL,
  PHYSICAL_INTENT_TOOL,
  PHYSICAL_CAPABILITIES_TOOL,
  PHYSICAL_ROUTE_TOOL,
  READ_AGENT_SKILL_TOOL,
  PHYSICAL_EXECUTION_INSPECTION_TOOL,
  PHYSICAL_SETUP_INSPECTION_TOOL
]);
function cleanMessage(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
function createPhysicalWorkflowState(nodeOrigin) {
  return Object.freeze({
    nodeOrigin,
    generation: 0,
    status: "unchecked",
    snapshot: null,
    response: null,
    requestedIntent: null,
    exploration: null,
    agentSkillId: null,
    capabilityCatalog: null,
    routeReceipt: null,
    routeError: null,
    error: null
  });
}
function updatePhysicalWorkflow(state2, event) {
  if (!state2 || typeof state2 !== "object")
    throw new TypeError("Physical workflow state is required");
  if (!event || typeof event !== "object")
    throw new TypeError("Physical workflow event is required");
  if (event.generation !== undefined && event.generation !== state2.generation)
    return state2;
  if (["checking", "catalog-checking", "route-checking", "snapshot", "intent", "error", "plan-error", "reset-intent"].includes(event.type)) {
    state2 = { ...state2, generation: state2.generation + 1 };
  }
  if (event.type === "checking") {
    return Object.freeze({ ...state2, status: "checking", error: null, routeReceipt: null, routeError: null, capabilityCatalog: null });
  }
  if (event.type === "agent-skill")
    return Object.freeze({ ...state2, agentSkillId: cleanMessage(event.skillId) });
  if (event.type === "catalog-checking")
    return Object.freeze({ ...state2, capabilityCatalog: null, routeReceipt: null, routeError: null });
  if (event.type === "route-checking")
    return Object.freeze({ ...state2, routeReceipt: null, routeError: null });
  if (event.type === "capability-catalog") {
    if (event.catalog?.physicalExecutionAuthorized !== false)
      throw new TypeError("Physical capability catalog cannot authorize execution");
    return Object.freeze({ ...state2, capabilityCatalog: event.catalog, routeReceipt: null, routeError: null });
  }
  if (event.type === "route") {
    if (event.receipt?.physicalExecutionAuthorized !== false || event.receipt?.decision?.physical_execution_authorized !== false)
      throw new TypeError("Physical route preview cannot authorize execution");
    return Object.freeze({ ...state2, routeReceipt: event.receipt, routeError: null });
  }
  if (event.type === "route-error")
    return Object.freeze({ ...state2, capabilityCatalog: null, routeReceipt: null, routeError: cleanMessage(event.error?.message || event.error) });
  if (event.type === "snapshot") {
    return Object.freeze({
      ...state2,
      status: "connected",
      snapshot: event.snapshot,
      response: null,
      requestedIntent: null,
      exploration: null,
      capabilityCatalog: null,
      routeReceipt: null,
      routeError: null,
      error: null
    });
  }
  if (event.type === "intent") {
    return Object.freeze({
      ...state2,
      status: "connected",
      response: event.response,
      requestedIntent: cleanMessage(event.requestedIntent),
      exploration: null,
      routeReceipt: null,
      routeError: null,
      error: null
    });
  }
  if (event.type === "exploration") {
    if (!state2.response)
      throw new TypeError("Physical commissioning requires a grounded intent");
    if (!event.exploration || event.exploration.status !== "draft" || event.exploration.physicalExecutionAuthorized !== false || event.exploration.method !== null || event.exploration.durationMinutes !== null || event.exploration.maxTrials !== null || event.exploration.methodSelectionRequired !== true || event.exploration.boundsSelectionRequired !== true || event.exploration.requiresLocalApproval !== true || event.exploration.interpretationDigest !== state2.response.interpretation?.interpretationDigest) {
      throw new TypeError("A non-authorizing physical commissioning draft is required");
    }
    return Object.freeze({ ...state2, exploration: event.exploration, error: null });
  }
  if (event.type === "exploration-declined") {
    if (!state2.response)
      throw new TypeError("Physical commissioning requires a grounded intent");
    return Object.freeze({
      ...state2,
      exploration: Object.freeze({
        status: "declined",
        physicalExecutionAuthorized: false
      }),
      error: null
    });
  }
  if (event.type === "error") {
    return Object.freeze({
      ...state2,
      status: "unavailable",
      snapshot: null,
      response: null,
      exploration: null,
      capabilityCatalog: null,
      routeReceipt: null,
      routeError: null,
      error: cleanMessage(event.error?.message || event.error || "Physical node unavailable")
    });
  }
  if (event.type === "plan-error") {
    return Object.freeze({
      ...state2,
      status: state2.snapshot ? "connected" : "unavailable",
      response: null,
      requestedIntent: cleanMessage(event.requestedIntent),
      exploration: null,
      routeReceipt: null,
      routeError: null,
      error: cleanMessage(event.error?.message || event.error || "Physical plan rejected")
    });
  }
  if (event.type === "reset-intent") {
    return Object.freeze({ ...state2, response: null, requestedIntent: null, exploration: null, capabilityCatalog: null, routeReceipt: null, routeError: null, error: null });
  }
  throw new TypeError(`Unknown physical workflow event: ${event.type}`);
}
function observedPhysicalDevices(snapshot) {
  const devices = snapshot?.discovery?.devices;
  return Array.isArray(devices) ? devices.filter((device) => device?.detected === true) : [];
}
var ROUTE_REASON_LABELS = Object.freeze({
  precondition_unknown: "Required physical state is unknown",
  precondition_missing: "Required observation is missing",
  precondition_violated: "A required physical condition is not met",
  precondition_stale: "Required observation is stale",
  precondition_from_future: "Observation timing is invalid",
  precondition_invocation_mismatch: "Observation belongs to a different invocation",
  precondition_state_mismatch: "Observation belongs to a different physical state",
  precondition_requirement_mismatch: "Observation does not establish the required condition",
  qualification_status_not_allowed: "Qualification does not meet local policy",
  qualification_missing: "Qualification evidence is missing",
  qualification_mismatch: "Qualification evidence no longer matches",
  calibration_missing: "Required calibration is missing",
  calibration_mismatch: "Calibration has changed",
  artifact_missing: "Implementation artifact is unavailable",
  artifact_mismatch: "Implementation artifact has changed",
  dependency_missing: "A required dependency is missing",
  dependency_mismatch: "A required dependency has changed",
  implementation_blocked: "Capability implementation is blocked by local qualification or policy",
  execution_target_unavailable: "Execution target is unavailable",
  execution_target_mismatch: "Execution target does not match",
  operator_approval_required: "Separate operator approval is required"
});
function compactPhysicalSnapshotForModel(snapshot) {
  const devices = observedPhysicalDevices(snapshot);
  const candidateMode = snapshot.discovery.mode === "candidates";
  const providerIssues = (Array.isArray(snapshot.discovery.providerErrors) ? snapshot.discovery.providerErrors : []).slice(0, 64).map((issue) => ({ status: ["degraded", "unavailable", "error"].includes(issue?.status) ? issue.status : "unknown" }));
  return {
    discovery: {
      ...candidateMode ? {
        mode: "candidates",
        partial: providerIssues.length > 0,
        providerIssues
      } : {},
      observedAt: snapshot.discovery.observedAt,
      snapshotDigest: snapshot.discovery.snapshotDigest,
      bindingDigest: snapshot.discoveryBindingDigest,
      summary: candidateMode ? {
        observed: devices.length,
        adapterAvailable: devices.filter((device) => device.adapterStatus === "available").length,
        adapterSetupRequired: devices.filter((device) => device.adapterStatus === "setup-required").length,
        commissioned: devices.filter((device) => device.commissioningStatus === "commissioned").length,
        reportedReady: devices.filter((device) => device.ready).length,
        allReportedReady: devices.length > 0 && devices.every((device) => device.ready)
      } : {
        observed: devices.length,
        adapterReady: devices.filter((device) => device.driverReady).length,
        commissioned: devices.filter((device) => device.calibrationReady).length,
        ready: devices.filter((device) => device.ready).length,
        allReady: devices.length > 0 && devices.every((device) => device.ready)
      },
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        ...device.displayName ? { displayName: cleanMessage(device.displayName) } : {},
        kind: device.kind,
        transport: device.transport ?? null,
        roles: device.roles,
        capabilities: device.capabilities,
        detected: device.detected,
        adapterStatus: device.adapterStatus ?? null,
        commissioningStatus: device.commissioningStatus ?? null,
        ...candidateMode ? {
          presence: "observed",
          reportedReadiness: device.readiness ?? null,
          reportedReady: device.ready,
          assessments: {
            driverHealth: "unassessed",
            capture: "unassessed",
            calibration: "unassessed",
            calibrationRequirements: "unassessed"
          }
        } : {
          readiness: device.readiness ?? (device.ready ? "ready" : "setup-required"),
          driverReady: device.driverReady,
          calibrationReady: device.calibrationReady,
          ready: device.ready
        }
      }))
    },
    physicalExecutionAuthorized: false
  };
}
function compactPhysicalIntentForModel(response) {
  const interpretation = response.interpretation;
  const observation = response.observationEvidence || {};
  return {
    status: interpretation.status,
    action: interpretation.action ?? null,
    grounding: interpretation.grounding,
    workflowIntent: interpretation.workflowIntent,
    requiredOperations: interpretation.requiredOperations,
    gaps: interpretation.gaps,
    questions: interpretation.questions,
    interpretationDigest: interpretation.interpretationDigest,
    discoverySnapshotDigest: response.discoverySnapshotDigest,
    discoveryBindingDigest: response.discoveryBindingDigest,
    observationEvidence: {
      kind: observation.kind ?? null,
      status: observation.status ?? null,
      observationDigest: observation.observationDigest ?? null,
      cameraOpened: observation.cameraOpened === true,
      rawFramePersisted: observation.rawFramePersisted === true,
      physicalExecutionAuthorized: false,
      claim: observation.claim ?? null
    },
    physicalExecutionAuthorized: false
  };
}
function createPhysicalTools({
  defineTool,
  client,
  onSnapshot,
  onIntent,
  onError,
  onPlanError,
  onCatalog,
  onRoute,
  onRouteError,
  onRouteChecking
}) {
  const result = (value, summary4) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: { displaySummary: summary4 }
  });
  const inspect = async () => {
    onRouteChecking?.("checking");
    try {
      const snapshot = await client.inspect();
      onSnapshot?.(snapshot);
      return snapshot;
    } catch (error) {
      onError?.(error);
      throw error;
    }
  };
  return [
    defineTool({
      name: PHYSICAL_DISCOVERY_TOOL,
      label: "Inspect physical system",
      description: "Read the local Physical Systems node discovery snapshot. It reports only observed device candidates and their adapter, commissioning, and readiness state without opening hardware or authorizing movement.",
      parameters: { type: "object", additionalProperties: false },
      async execute() {
        const snapshot = await inspect();
        return result(compactPhysicalSnapshotForModel(snapshot), "Inspected local physical system");
      }
    }),
    defineTool({
      name: PHYSICAL_CAPABILITIES_TOOL,
      label: "Inspect physical capabilities",
      description: "Read the node's registered physical capabilities, typed input contracts and workcell bindings. This is not device execution, qualification or an Agent Skill catalog. Use exact returned identifiers and digests for route previews; do not invent missing capabilities.",
      parameters: { type: "object", additionalProperties: false },
      async execute(_toolCallId, params = {}) {
        const generation = onRouteChecking?.("catalog-checking");
        try {
          if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length)
            throw new TypeError("Physical capability inspection accepts no inputs");
          const catalog = await client.capabilities();
          if (onCatalog?.(catalog, generation) === false)
            throw new Error("Capability catalog superseded by a newer workflow request");
          return result(catalog, "Inspected registered physical capabilities");
        } catch (error) {
          onRouteError?.(error, generation);
          throw error;
        }
      }
    }),
    defineTool({
      name: PHYSICAL_ROUTE_TOOL,
      label: "Preview physical capability",
      description: "Request the local node's deterministic capability implementation selection for one typed invocation. Copy context digests from inspect_physical_capabilities. The node supplies live evidence and policy; callers cannot provide readiness, qualification or approval. This only produces a route receipt and never moves hardware.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["capabilityId", "workcellId", "arguments", "expectedRegistryDigest", "expectedCandidateBindingDigest", "expectedCatalogDigest", "expectedWorkcellDigest"],
        properties: {
          capabilityId: { type: "string", minLength: 1, maxLength: 128 },
          workcellId: { type: "string", minLength: 1, maxLength: 128 },
          arguments: {
            type: "array",
            maxItems: 128,
            description: "Typed arguments sorted by their exact field name, with no duplicates.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "value_type", "value"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 128 },
                value_type: { type: "string", enum: ["boolean", "integer", "number", "string", "identifier", "digest"] },
                value: { anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string", maxLength: 512 }] }
              }
            }
          },
          ...Object.fromEntries(["expectedRegistryDigest", "expectedCandidateBindingDigest", "expectedCatalogDigest", "expectedWorkcellDigest"].map((name) => [name, { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }]))
        }
      },
      async execute(_toolCallId, params) {
        const generation = onRouteChecking?.("route-checking");
        try {
          if (!params || typeof params !== "object" || Array.isArray(params) || Object.hasOwn(params, "contractVersion"))
            throw new TypeError("Use only the declared capability preview tool inputs");
          const request = normalizePhysicalRouteRequest({ ...params, contractVersion: PHYSICAL_ROUTE_REQUEST_VERSION });
          const receipt = await client.previewCapability(request);
          if (onRoute?.(receipt, generation) === false)
            throw new Error("Capability preview superseded by a newer workflow request");
          return result({ ...receipt, receiptUrl: `${client.origin}${physicalRouteReceiptPath(receipt.receiptDigest)}` }, "Previewed capability implementation selection; no movement");
        } catch (error) {
          onRouteError?.(error, generation);
          throw error;
        }
      }
    }),
    defineTool({
      name: PHYSICAL_INTENT_TOOL,
      label: "Plan physical workflow",
      description: "Ground one operator-described physical outcome against a fresh local discovery snapshot and observation. This can expose questions and commissioning gaps but cannot authorize or execute motion.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["intent"],
        properties: {
          intent: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "The operator's physical outcome in their own words."
          }
        }
      },
      async execute(_toolCallId, params) {
        const snapshot = await inspect();
        try {
          const response = await client.interpret(params?.intent, snapshot.discoveryBindingDigest, snapshot);
          onIntent?.(response, params?.intent);
          return result(compactPhysicalIntentForModel(response), "Grounded physical workflow intent");
        } catch (error) {
          onPlanError?.(error, params?.intent);
          throw error;
        }
      }
    })
  ];
}
// ../harness-gripper-check/packages/cli/src/physical/camera-preview-client.js
import { createHash as createHash7 } from "node:crypto";
var ENDPOINT = "/v1/physical/camera-preview";
var VERSION = "experimental-camera-preview-";
var MAX_WIRE_BYTES = 4 * 1024 * 1024;
var MAX_JPEG_BYTES = 2 * 1024 * 1024;
var ERROR_CODES = ["open-failed", "device-unavailable", "capture-failed", "geometry-mismatch", "driver-unavailable", "permission-denied", "capture-ended", "worker-start-failed", "worker-still-running"];

class CameraHttpError extends Error {
}
function invalid() {
  throw new TypeError("Camera preview response failed contract validation");
}
function assert2(value) {
  if (!value)
    invalid();
}
function object4(value) {
  assert2(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function fields2(value, names, optional = []) {
  object4(value);
  assert2(names.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => names.includes(key) || optional.includes(key)));
  return value;
}
function text3(value, maximum = 256) {
  assert2(typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value));
  return value;
}
function id4(value, maximum = 128) {
  assert2(typeof value === "string" && value.length <= maximum && /^[a-z][a-z0-9-]*$/.test(value));
  return value;
}
function digest3(value) {
  assert2(typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value));
  return value;
}
function integer3(value, maximum = Number.MAX_SAFE_INTEGER) {
  assert2(Number.isSafeInteger(value) && value >= 0 && value <= maximum);
  return value;
}
function oneOf2(value, options) {
  assert2(options.includes(value));
  return value;
}
function nullable2(value, normalize) {
  return value === null ? null : normalize(value);
}
function ns(value) {
  assert2(typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n);
  return value;
}
function receiptNs(value) {
  assert2(typeof value === "bigint" || Number.isSafeInteger(value));
  return ns(String(value));
}
function identity2(value) {
  text3(value, 512);
  assert2(/^\/dev\/video[0-9]+$/.test(value) || /^\/dev\/v4l\/by-id\/[^/]+$/.test(value));
  return value;
}
function sha(bytes) {
  return `sha256:${createHash7("sha256").update(bytes).digest("hex")}`;
}
function normalizeCandidate2(value) {
  fields2(value, ["candidateId", "candidateDigest", "displayName", "observedIdentity", "identityStability", "adapter"]);
  fields2(value.adapter, ["status", "adapterId", "detail"]);
  return {
    candidateId: id4(value.candidateId),
    candidateDigest: digest3(value.candidateDigest),
    displayName: text3(value.displayName),
    observedIdentity: identity2(value.observedIdentity),
    identityStability: oneOf2(value.identityStability, ["stable", "session"]),
    adapter: { status: oneOf2(value.adapter.status, ["available", "setup-required", "unavailable"]), adapterId: nullable2(value.adapter.adapterId, id4) }
  };
}
function normalizeStatus(value, { inventory = false } = {}) {
  fields2(value, ["contractVersion", "state", "captureSessionId", "selectedCandidateId", "latestFrameId", "frameFresh", "frameAgeMs", "staleAfterMs", "errorCode", "observationStatus", "physicalState", "physicalExecutionAuthorized", "rawFramePersisted"], ["availableCameras"]);
  assert2(value.contractVersion === `${VERSION}status-v1` && value.physicalState === "unknown" && value.physicalExecutionAuthorized === false && value.rawFramePersisted === false);
  const state2 = oneOf2(value.state, ["idle", "starting", "streaming", "stale", "error", "stopped", "stop-unconfirmed"]);
  const result = {
    phase: state2 === "streaming" ? "live" : state2,
    captureSessionId: nullable2(value.captureSessionId, (v) => id4(v, 64)),
    selectedCandidateId: nullable2(value.selectedCandidateId, id4),
    latestFrameId: nullable2(value.latestFrameId, id4),
    frameFresh: value.frameFresh,
    frameAgeMs: nullable2(value.frameAgeMs, integer3),
    staleAfterMs: value.staleAfterMs,
    errorCode: nullable2(value.errorCode, (v) => oneOf2(v, ERROR_CODES)),
    observationStatus: oneOf2(value.observationStatus, ["not-configured", "provisional", "blocked", "simulated", "stale"]),
    physicalState: "unknown",
    physicalExecutionAuthorized: false,
    rawFramePersisted: false
  };
  assert2(result.frameFresh === (state2 === "streaming") && result.staleAfterMs === 2000);
  assert2(result.captureSessionId === null === (result.selectedCandidateId === null));
  if (state2 === "idle")
    assert2(result.captureSessionId === null && result.latestFrameId === null);
  else
    assert2(result.captureSessionId !== null);
  if (state2 === "streaming")
    assert2(result.latestFrameId !== null && result.frameAgeMs !== null && result.frameAgeMs < result.staleAfterMs);
  if (result.latestFrameId !== null)
    assert2(result.latestFrameId.startsWith(`${result.captureSessionId}-`) && result.frameAgeMs !== null);
  else
    assert2(result.frameAgeMs === null);
  if (state2 === "stopped")
    assert2(result.latestFrameId === null);
  if (inventory || Object.hasOwn(value, "availableCameras")) {
    assert2(Array.isArray(value.availableCameras) && value.availableCameras.length <= 128);
    result.availableCameras = value.availableCameras.map(normalizeCandidate2);
    assert2(new Set(result.availableCameras.map((item) => item.candidateId)).size === result.availableCameras.length);
  }
  return result;
}
function jpegGeometry(bytes) {
  assert2(bytes.length >= 4 && bytes.length <= MAX_JPEG_BYTES && bytes.readUInt16BE(0) === 65496 && bytes.readUInt16BE(bytes.length - 2) === 65497);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    assert2(bytes[offset++] === 255);
    while (bytes[offset] === 255)
      offset += 1;
    const marker = bytes[offset++];
    assert2(marker !== 218 && marker !== 217 && offset + 2 <= bytes.length);
    const size = bytes.readUInt16BE(offset);
    assert2(size >= 2 && offset + size <= bytes.length);
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      assert2(size >= 8);
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += size;
  }
  invalid();
}
function normalizeObservation(value, packet, status) {
  if (value === null) {
    assert2(packet.analysis === null && status.observationStatus === "not-configured");
    return null;
  }
  fields2(value, ["frameId", "receipt", "routingEvidencePublished"]);
  assert2(value.frameId === packet.frameId && value.routingEvidencePublished === false && packet.analysis !== null);
  const receipt = object4(value.receipt);
  const capture = object4(receipt.capture);
  const boundary = object4(receipt.evidenceBoundary);
  assert2(receipt.contractVersion === "experimental-fixed-camera-observation-v1" && receipt.hardwareIdentity === packet.source.hardwareIdentity);
  assert2(capture.sequence === packet.sequence && receiptNs(capture.capturedAtMonotonicNs) === packet.capture.capturedAtMonotonicNs && capture.clockSessionId === packet.capture.clockSessionId && capture.clockDomain === "host-monotonic" && capture.width === packet.source.width && capture.height === packet.source.height && capture.rotationDegrees === packet.preview.rotationDegrees && capture.analysisFrameDigest === packet.analysis.digest && capture.timestampBasis === "host-read-window-start" && capture.sensorExposureAgeBounded === false && capture.rawFramePersisted === false);
  const expires = receiptNs(capture.expiresAtMonotonicNs);
  assert2(BigInt(expires) > BigInt(packet.capture.capturedAtMonotonicNs));
  oneOf2(receipt.status, ["blocked", "observed-provisional"]);
  assert2(typeof boundary.cameraOpened === "boolean" && boundary.perceptionExecuted === true && boundary.robotOpened === false && boundary.torqueEnabled === false && boundary.jointCommandsSent === 0 && boundary.physicalTaskSuccessProven === false && boundary.rawFramePersisted === false);
  if (packet.source.kind === "synthetic")
    assert2(boundary.cameraOpened === false);
  const expected = !boundary.cameraOpened ? "simulated" : receipt.status === "blocked" ? "blocked" : "provisional";
  assert2(status.observationStatus === expected || status.observationStatus === "stale");
  if (status.observationStatus !== "stale")
    assert2(BigInt(packet.capture.capturedAtMonotonicNs) + BigInt(status.frameAgeMs) * 1000000n < BigInt(expires));
  return {
    frameId: packet.frameId,
    observationDigest: digest3(receipt.observationDigest),
    status: status.observationStatus,
    capturedAtMonotonicNs: packet.capture.capturedAtMonotonicNs,
    expiresAtMonotonicNs: expires,
    routingEvidencePublished: false,
    physicalExecutionAuthorized: false
  };
}
function normalizePacket(value, status) {
  fields2(value, ["contractVersion", "frameId", "candidateId", "candidateDigest", "captureSessionId", "sequence", "source", "capture", "preview", "analysis", "observation", "physicalExecutionAuthorized"]);
  assert2(value.contractVersion === `${VERSION}packet-v1` && value.physicalExecutionAuthorized === false);
  const sequence = integer3(value.sequence);
  const session = id4(value.captureSessionId, 64);
  const candidateId = id4(value.candidateId);
  assert2(value.frameId === `${session}-${sequence}` && value.frameId === status.latestFrameId && session === status.captureSessionId && candidateId === status.selectedCandidateId);
  fields2(value.source, ["kind", "hardwareIdentity", "identityStability", "pixelFormat", "digest", "width", "height"]);
  const source = {
    kind: oneOf2(value.source.kind, ["synthetic", "live-camera"]),
    hardwareIdentity: identity2(value.source.hardwareIdentity),
    identityStability: oneOf2(value.source.identityStability, ["stable", "session"]),
    pixelFormat: oneOf2(value.source.pixelFormat, ["bgr8"]),
    digest: digest3(value.source.digest),
    width: integer3(value.source.width, 1920),
    height: integer3(value.source.height, 1080)
  };
  assert2(source.width > 0 && source.height > 0);
  fields2(value.capture, ["capturedAtMonotonicNs", "clockDomain", "clockSessionId", "timestampBasis", "sensorExposureAgeBounded"]);
  const capture = {
    capturedAtMonotonicNs: ns(value.capture.capturedAtMonotonicNs),
    clockSessionId: id4(value.capture.clockSessionId, 64),
    clockDomain: oneOf2(value.capture.clockDomain, ["host-monotonic"]),
    timestampBasis: oneOf2(value.capture.timestampBasis, ["host-read-window-start"]),
    sensorExposureAgeBounded: false
  };
  assert2(value.capture.sensorExposureAgeBounded === false);
  fields2(value.preview, ["contentType", "encoding", "data", "digest", "derivedFromSourceDigest", "width", "height", "rotationDegrees"]);
  const preview = value.preview;
  assert2(preview.contentType === "image/jpeg" && preview.encoding === "base64" && typeof preview.data === "string" && preview.data.length <= 4 * Math.ceil(MAX_JPEG_BYTES / 3) && preview.data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(preview.data));
  const jpegBytes = Buffer.from(preview.data, "base64");
  assert2(jpegBytes.toString("base64") === preview.data && sha(jpegBytes) === digest3(preview.digest));
  const dimensions = jpegGeometry(jpegBytes);
  assert2(preview.derivedFromSourceDigest === source.digest && preview.width === source.width && preview.height === source.height && dimensions.width === source.width && dimensions.height === source.height);
  oneOf2(preview.rotationDegrees, [0, 180]);
  let analysis = null;
  if (value.analysis !== null) {
    fields2(value.analysis, ["pixelFormat", "digest", "derivedFromSourceDigest", "rotationDegrees"]);
    assert2(value.analysis.pixelFormat === "hsv8" && value.analysis.derivedFromSourceDigest === source.digest && value.analysis.rotationDegrees === preview.rotationDegrees);
    analysis = { pixelFormat: "hsv8", digest: digest3(value.analysis.digest), derivedFromSourceDigest: source.digest, rotationDegrees: preview.rotationDegrees };
  }
  const result = {
    frameId: value.frameId,
    candidateId,
    candidateDigest: digest3(value.candidateDigest),
    captureSessionId: session,
    sequence,
    jpegBytes,
    previewDigest: preview.digest,
    source,
    capture,
    preview: { contentType: "image/jpeg", digest: preview.digest, derivedFromSourceDigest: source.digest, width: source.width, height: source.height, rotationDegrees: preview.rotationDegrees },
    analysis,
    observation: null,
    physicalExecutionAuthorized: false
  };
  result.observation = normalizeObservation(value.observation, result, status);
  return result;
}
async function readBoundedJson(response, maximum) {
  const reader = response.body?.getReader?.();
  assert2(reader);
  let size = 0;
  const chunks = [];
  try {
    assert2(response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json");
    const length = response.headers.get("content-length");
    if (length !== null)
      assert2(/^[0-9]+$/.test(length) && Number(length) <= maximum);
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      assert2(size <= maximum);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      assert2(context && /^-?[0-9]+$/.test(context.source));
      return BigInt(context.source);
    }
    return value;
  });
}
function createCameraPreviewClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl);
  if (typeof fetchImpl !== "function")
    throw new TypeError("Camera preview requires HTTP transport");
  let previous = null;
  async function request(path2, body) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new TypeError("Camera preview requires a configured server-side token");
    try {
      const response = await fetchImpl(new URL(path2, origin), {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...body === undefined ? {} : { "Content-Type": "application/json" } },
        ...body === undefined ? {} : { body: JSON.stringify(body) }
      });
      if (response.redirected || response.type === "opaqueredirect")
        invalid();
      if (response.url)
        assert2(new URL(response.url).href === new URL(path2, origin).href);
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        const status = Number.isInteger(response.status) ? response.status : 503;
        const code = { 401: "camera_unauthorized", 403: "camera_forbidden", 409: "camera_conflict", 503: "camera_unavailable" }[status] ?? "camera_request_failed";
        const error = new CameraHttpError({ 401: "Camera preview credentials were rejected", 403: "Camera preview origin was rejected", 409: "Camera selection or capture session changed; refresh and select again", 503: "Camera preview is unavailable on the local node" }[status] ?? "Camera preview request failed");
        error.code = code;
        error.status = status;
        throw error;
      }
      return await readBoundedJson(response, path2.endsWith("/frame") ? MAX_WIRE_BYTES : 256 * 1024);
    } catch (error) {
      if (error instanceof CameraHttpError)
        throw error;
      throw new Error("Camera preview transport or response is unavailable", { cause: undefined });
    }
  }
  return Object.freeze({
    async status() {
      return normalizeStatus(await request(ENDPOINT), { inventory: true });
    },
    async frame() {
      const requestedAt = performance.now();
      const value = await request(`${ENDPOINT}/frame`);
      fields2(value, ["contractVersion", "status", "frame"]);
      assert2(value.contractVersion === `${VERSION}frame-v1`);
      const status = normalizeStatus(value.status);
      if (!status.frameFresh)
        return { status, frame: null };
      const elapsed = performance.now() - requestedAt;
      if (status.frameAgeMs + elapsed >= status.staleAfterMs) {
        return { status: { ...status, phase: "stale", frameFresh: false, observationStatus: status.observationStatus === "not-configured" ? "not-configured" : "stale" }, frame: null };
      }
      const frame = normalizePacket(value.frame, status);
      const fingerprint = sha(JSON.stringify({
        source: frame.source,
        capture: frame.capture,
        preview: frame.preview,
        analysis: frame.analysis,
        observationDigest: frame.observation?.observationDigest ?? null,
        observationExpiresAt: frame.observation?.expiresAtMonotonicNs ?? null
      }));
      if (previous?.captureSessionId === frame.captureSessionId) {
        assert2(frame.candidateId === previous.candidateId && frame.candidateDigest === previous.candidateDigest && frame.capture.clockSessionId === previous.capture.clockSessionId && frame.sequence >= previous.sequence && frame.source.hardwareIdentity === previous.source.hardwareIdentity && frame.source.identityStability === previous.source.identityStability && frame.source.kind === previous.source.kind);
        if (frame.sequence === previous.sequence)
          assert2(fingerprint === previous.fingerprint && status.frameAgeMs >= previous.frameAgeMs);
        else
          assert2(BigInt(frame.capture.capturedAtMonotonicNs) > BigInt(previous.capture.capturedAtMonotonicNs));
      }
      previous = { ...frame, jpegBytes: undefined, observation: undefined, frameAgeMs: status.frameAgeMs, fingerprint };
      return { status: { ...status, frameAgeMs: status.frameAgeMs + Math.ceil(elapsed) }, frame };
    },
    async start(value) {
      fields2(value, ["candidateId", "expectedCandidateDigest"]);
      const candidateId = id4(value.candidateId);
      const status = normalizeStatus(await request(`${ENDPOINT}:start`, { contractVersion: `${VERSION}start-v1`, candidateId, expectedCandidateDigest: digest3(value.expectedCandidateDigest) }));
      assert2(status.selectedCandidateId === candidateId && !["idle", "stopped"].includes(status.phase));
      previous = null;
      return status;
    },
    async stop(value) {
      fields2(value, ["expectedCaptureSessionId"]);
      const expectedCaptureSessionId = id4(value.expectedCaptureSessionId, 64);
      const status = normalizeStatus(await request(`${ENDPOINT}:stop`, { contractVersion: `${VERSION}stop-v1`, expectedCaptureSessionId }));
      assert2(status.captureSessionId === expectedCaptureSessionId && ["stopped", "stop-unconfirmed"].includes(status.phase));
      if (status.phase === "stopped")
        previous = null;
      return status;
    }
  });
}
// ../harness-gripper-check/packages/cli/src/harness/workcell-view/view-state.js
function cameraIsFresh(camera, now = Date.now()) {
  const status = camera?.status;
  const receivedAt = Date.parse(camera?.receivedAt || "");
  const elapsed = now - receivedAt;
  return Boolean(camera?.availability === "available" && camera.frame && camera.previewFrameId && status?.phase === "live" && status.frameFresh === true && Number.isFinite(elapsed) && elapsed >= 0 && Number.isFinite(status.frameAgeMs) && status.frameAgeMs >= 0 && Number.isFinite(status.staleAfterMs) && status.staleAfterMs > 0 && elapsed + status.frameAgeMs < status.staleAfterMs);
}
// ../harness-gripper-check/packages/cli/src/auth/secret-store.js
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path2 from "node:path";
var DPAPI_PROCESS_TIMEOUT_MS = 30000;
var SECRET_SERVICE_PROCESS_TIMEOUT_MS = 15000;
var SECRET_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024;
var SECRET_VALUE_MAX_BYTES = 1024 * 1024;
var SECRET_TOOL_VALUE_MAX_BYTES = 8 * 1024 - 1;
var SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
var SECRET_TOOL_ATTRIBUTES = Object.freeze([
  "application",
  "ai.tinyedge.cli",
  "credential"
]);
function execFileWithInput(executable, args, { input = "", ...options } = {}) {
  return new Promise((resolve2, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled)
        return;
      settled = true;
      callback(value);
    };
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.defineProperty(error, "tinyedgeStderrPresent", {
          configurable: true,
          value: Buffer.byteLength(stderr || "") > 0
        });
        settle(reject, error);
        return;
      }
      settle(resolve2, { stdout, stderr });
    });
    child.stdin.once("error", (error) => {
      if (settled || error?.code === "EPIPE")
        return;
      child.kill();
      settle(reject, error);
    });
    child.stdin.end(input);
  });
}
var DPAPI_PROTECT = String.raw`
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
var DPAPI_UNPROTECT = String.raw`
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;
async function powershell(script, stdin, run = execFileWithInput) {
  const { stdout } = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: stdin,
    windowsHide: true,
    maxBuffer: SECRET_PROCESS_MAX_OUTPUT_BYTES,
    shell: false,
    timeout: DPAPI_PROCESS_TIMEOUT_MS
  });
  return String(stdout).trim();
}
function requireSecretName(name) {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    throw new TypeError("TinyEdge secret name is invalid");
  }
  return name;
}
function requireSecretValue(value, maximumBytes = SECRET_VALUE_MAX_BYTES) {
  const normalized = String(value);
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new TypeError("TinyEdge secret value is empty or too large");
  }
  return normalized;
}
function secretToolAttributes(name) {
  return [...SECRET_TOOL_ATTRIBUTES, requireSecretName(name)];
}
function unavailableSecretServiceError() {
  const error = new Error("Linux Secret Service credential storage is unavailable. " + "Install secret-tool and unlock a Secret Service keyring for this desktop session.");
  error.code = "TINYEDGE_SECRET_SERVICE_UNAVAILABLE";
  return error;
}
async function secretTool(args, { input = "", missingIsNull = false, run = execFileWithInput } = {}) {
  try {
    const { stdout } = await run("secret-tool", args, {
      encoding: "utf8",
      input,
      maxBuffer: SECRET_PROCESS_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: SECRET_SERVICE_PROCESS_TIMEOUT_MS,
      windowsHide: true
    });
    return String(stdout);
  } catch (error) {
    if (missingIsNull && error?.code === 1 && error?.tinyedgeStderrPresent === false)
      return null;
    throw unavailableSecretServiceError();
  }
}
function createWindowsDpapiSecretStore({ configDir, run = execFileWithInput }) {
  const directory = path2.join(configDir, "secrets");
  const fileFor = (name) => path2.join(directory, `${requireSecretName(name)}.dpapi`);
  return Object.freeze({
    kind: "windows-dpapi",
    async read(name) {
      let protectedValue;
      try {
        protectedValue = (await readFile(fileFor(name), "utf8")).trim();
      } catch (error) {
        if (error?.code === "ENOENT")
          return null;
        throw error;
      }
      const plain = await powershell(DPAPI_UNPROTECT, protectedValue, run);
      return Buffer.from(plain, "base64").toString("utf8");
    },
    async write(name, value) {
      await mkdir(directory, { recursive: true, mode: 448 });
      const encoded = Buffer.from(requireSecretValue(value), "utf8").toString("base64");
      const protectedValue = await powershell(DPAPI_PROTECT, encoded, run);
      await writeFile(fileFor(name), `${protectedValue}
`, { encoding: "utf8", mode: 384 });
    },
    async delete(name) {
      await rm(fileFor(name), { force: true });
    }
  });
}
function createLinuxSecretServiceSecretStore({ run = execFileWithInput } = {}) {
  return Object.freeze({
    kind: "linux-secret-service",
    async read(name) {
      const stdout = await secretTool(["lookup", ...secretToolAttributes(name)], { missingIsNull: true, run });
      if (stdout === null)
        return null;
      return stdout;
    },
    async write(name, value) {
      await secretTool([
        "store",
        "--label=Physical Systems credential",
        ...secretToolAttributes(name)
      ], { input: requireSecretValue(value, SECRET_TOOL_VALUE_MAX_BYTES), run });
    },
    async delete(name) {
      await secretTool(["clear", ...secretToolAttributes(name)], { missingIsNull: true, run });
    }
  });
}
function createNativeSecretStore({ configDir, platform = process.platform, run } = {}) {
  if (platform === "win32")
    return createWindowsDpapiSecretStore({ configDir, run });
  if (platform === "linux")
    return createLinuxSecretServiceSecretStore({ run });
  throw new Error(`Secure TinyEdge credential storage is not configured for ${platform}. ` + "Use Windows DPAPI, Linux Secret Service, or provide a native secret-store adapter.");
}

// ../harness-gripper-check/packages/desktop/src/connections.js
var exports_connections = {};
__export(exports_connections, {
  sshFailure: () => sshFailure,
  normalizeLocalEndpoint: () => normalizeLocalEndpoint,
  buildSshArgs: () => buildSshArgs,
  attachSSH: () => attachSSH,
  attachLocal: () => attachLocal
});
import { spawn } from "node:child_process";
import net from "node:net";
import path3 from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
function failure2(code, message) {
  return Object.assign(new Error(message), { code });
}
function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw failure2("INVALID_PROFILE", `Enter a valid ${label} port.`);
  return value;
}
function absoluteFile(value, label) {
  if (typeof value !== "string" || !path3.isAbsolute(value) || /[\x00-\x1f"\\]/.test(value))
    throw failure2("INVALID_PROFILE", `${label} must be an absolute file path without control characters.`);
  return value;
}
function normalizeLocalEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure2("INVALID_PROFILE", "Enter the Node loopback HTTP address.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw failure2("INVALID_PROFILE", "The Node address must be a loopback HTTP origin without credentials, query data, or a path.");
  }
  return url.origin;
}
function buildSshArgs(profile, localPort) {
  if (typeof profile.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(profile.host) || profile.host.includes(".."))
    throw failure2("INVALID_PROFILE", "Enter a host name or IP address, without SSH options.");
  if (typeof profile.username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(profile.username))
    throw failure2("INVALID_PROFILE", "Enter a valid SSH user name.");
  const args = [
    "-F",
    "none",
    "-N",
    "-T",
    "-n",
    "-a",
    "-x",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "RequestTTY=no",
    "-o",
    `UserKnownHostsFile="${absoluteFile(profile.knownHostsPath ?? path3.join(os.homedir(), ".ssh", "known_hosts"), "Known hosts file")}"`
  ];
  if (profile.keyPath)
    args.push("-i", absoluteFile(profile.keyPath, "SSH key"), "-o", "IdentitiesOnly=yes");
  args.push("-p", String(port(profile.port ?? 22, "SSH")), "-l", profile.username, "-L", `127.0.0.1:${port(localPort, "local")}:127.0.0.1:${port(profile.remotePort, "remote Node")}`, profile.host);
  return args;
}
function sshFailure(stderr = "") {
  if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(stderr))
    return failure2("SSH_HOST_TRUST_REQUIRED", "SSH host identity is not trusted or has changed. Ask the host operator for its fingerprint through a trusted channel. Verify and record the matching key in your selected known_hosts file using your normal SSH client, then retry. The desktop will not accept a key automatically.");
  if (/permission denied|authentication failed|no supported authentication/i.test(stderr))
    return failure2("SSH_AUTH_REQUIRED", "SSH authentication failed. Unlock the selected key in your SSH agent or select an authorized key, then retry. Password prompts are not supported by this attach flow.");
  if (/address already in use|cannot listen|forwarding failed/i.test(stderr))
    return failure2("SSH_FORWARD_FAILED", "The local SSH forwarding port could not be opened. Retry to allocate another port.");
  return failure2("SSH_DISCONNECTED", "The SSH tunnel could not stay connected. Check the computer address, SSH service, network, and key access, then retry. The remote Node was not stopped.");
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve2);
  });
  const selected = server.address().port;
  await new Promise((resolve2, reject) => server.close((error) => error ? reject(error) : resolve2()));
  return selected;
}
async function authorize(profile, { credentialResolver, probeNode }, endpoint, signal) {
  if (typeof credentialResolver !== "function" || typeof probeNode !== "function" || !profile.credentialRef)
    throw failure2("NODE_AUTH_REQUIRED", "SSH connectivity is separate from Node authorization. Configure a Node credential reference and supported identity verification before connecting.");
  const credential = await credentialResolver(profile.credentialRef);
  if (signal.aborted)
    throw failure2("CONNECTION_CANCELLED", "The connection request was cancelled before Node verification.");
  if (!credential)
    throw failure2("NODE_AUTH_REQUIRED", "The referenced Node credential is unavailable. Unlock the credential store or configure the intended Node credential, then retry.");
  const identity3 = await probeNode({ endpoint, credential, expectedNodeId: profile.expectedNodeId, signal });
  if (signal.aborted)
    throw failure2("CONNECTION_CANCELLED", "The connection request ended before Node verification completed.");
  if (!identity3 || identity3.authenticated !== true || typeof identity3.nodeId !== "string" || !identity3.nodeId)
    throw failure2("NODE_IDENTITY_UNVERIFIED", "The Node did not provide a supported authenticated identity. The connection remains unverified.");
  if (profile.expectedNodeId && identity3.nodeId !== profile.expectedNodeId)
    throw failure2("NODE_IDENTITY_CHANGED", "The responding Node identity differs from this project. Recheck the selected host and Node configuration before reconnecting.");
  return identity3;
}
async function attachLocal(profile, options = {}) {
  if (options.signal?.aborted)
    throw failure2("CONNECTION_CANCELLED", "The connection request was cancelled.");
  const endpoint = normalizeLocalEndpoint(profile.nodeUrl);
  const deadline = connectionDeadline(options.timeoutMs ?? 1e4, options.signal);
  try {
    const identity3 = await bounded(() => authorize(profile, options, endpoint, deadline.signal), deadline.signal);
    return { endpoint, identity: identity3, close: async () => {}, onDisconnect: () => () => {} };
  } finally {
    deadline.clear();
  }
}
function connectionDeadline(timeoutMs, parentSignal) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal, clear: () => clearTimeout(timer) };
}
function bounded(operation, signal) {
  if (signal.aborted)
    return Promise.reject(failure2("CONNECTION_TIMEOUT", "The connection request ended before verification. Retry after checking the target."));
  return new Promise((resolve2, reject) => {
    const aborted = () => reject(failure2("CONNECTION_TIMEOUT", "The connection request ended before verification. Retry after checking the target."));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(operation).then(resolve2, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
async function attachSSH(profile, options = {}) {
  if (options.signal?.aborted)
    throw failure2("CONNECTION_CANCELLED", "The connection request was cancelled.");
  buildSshArgs(profile, 12345);
  if (!profile.credentialRef || typeof options.credentialResolver !== "function" || typeof options.probeNode !== "function")
    throw failure2("NODE_AUTH_REQUIRED", "Configure separate Node authorization and identity verification before attaching over SSH.");
  const localPort = await (options.allocatePort ?? availablePort)();
  if (options.signal?.aborted)
    throw failure2("CONNECTION_CANCELLED", "The connection request was cancelled.");
  const endpoint = `http://127.0.0.1:${localPort}`;
  const child = (options.spawnProcess ?? spawn)("ssh", buildSshArgs(profile, localPort), { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  let ended = false;
  let processError;
  let closing = false;
  const listeners = new Set;
  const exit = new Promise((resolve2) => {
    const finish = (error) => {
      if (ended)
        return;
      ended = true;
      processError = error ?? sshFailure(stderr);
      resolve2();
      if (!closing)
        for (const listener of listeners)
          listener(processError);
    };
    child.once("error", () => finish(failure2("SSH_UNAVAILABLE", "The system SSH client could not be started. Install or repair it through your normal system administration process.")));
    child.once("exit", () => finish());
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8192);
  });
  const close = async () => {
    if (ended)
      return;
    closing = true;
    child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([exit, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(failure2("SSH_STOP_UNCONFIRMED", "SSH tunnel shutdown is not confirmed. Keep this connection owned and retry cleanup before replacing it.")), options.stopTimeoutMs ?? 3000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  const handle = { endpoint, identity: null, close, onDisconnect(listener) {
    listeners.add(listener);
    if (ended && !closing)
      queueMicrotask(() => {
        if (listeners.has(listener))
          listener(processError);
      });
    return () => listeners.delete(listener);
  } };
  const deadline = connectionDeadline(options.timeoutMs ?? 12000, options.signal);
  const signal = deadline.signal;
  try {
    let lastError;
    while (!signal.aborted) {
      if (ended)
        throw processError;
      try {
        handle.identity = await bounded(() => authorize(profile, options, endpoint, signal), signal);
        if (ended)
          throw processError;
        return handle;
      } catch (error) {
        if (["NODE_AUTH_REQUIRED", "NODE_IDENTITY_CHANGED", "NODE_IDENTITY_UNVERIFIED"].includes(error.code))
          throw error;
        lastError = error;
      }
      await delay(options.pollMs ?? 200, undefined, { signal }).catch(() => {});
    }
    throw ended ? processError : failure2("CONNECTION_TIMEOUT", `The SSH/Node connection could not be verified before the deadline.${lastError?.code === "NODE_AUTH_REQUIRED" ? " Check Node authorization." : ""} Retry after checking the target.`);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      cleanupError.connection = handle;
      throw cleanupError;
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

// ../harness-gripper-check/packages/operator-service/src/tools.js
var unavailable = () => {
  throw new Error("A bound service context is required");
};
var physical = createPhysicalTools({ defineTool: (tool) => tool, client: {} });
var experiment = createExperimentTools({ getController: unavailable });
var descriptions = {
  propose_local_experiment: "Propose a bounded synthetic alignment experiment, only with explicit mode simulation. This arithmetic fixture is not robot physics, a learned policy or physical execution. Explain the goal, fixture and maximum trial count. The proposal appears as an approval card in this conversation: direct the operator to review that exact card and choose Approve & continue. An operator may also inspect it in Experiments. A chat answer or question response cannot approve, and the agent has no approval tool. The trusted adapter supplies stable request identity; do not ask the operator or model to invent request IDs.",
  run_simulated_trial: "Run one synthetic alignment trial within the operator-approved experiment and remaining budget. Use the exact experimentId returned in this conversation and offsetMm within [-10,10]. Inspect each result and explain the next change. The trusted adapter derives stable request identity from this tool call. This invokes only the fixed synthetic fixture, never Node, cameras, robots or learned controllers. Exact operator approval must already exist; never fabricate or bypass it."
};
var agentToolDefinitions = Object.freeze([
  ...experiment,
  ...physical,
  createReadAgentSkillTool({ registry: { read: unavailable } }),
  { name: "inspect_physical_setup", label: "Inspect physical setup", description: "Inspect cached setup evidence and read-only requirements. No discovery, configuration, approval or hardware execution.", parameters: { type: "object", additionalProperties: false, properties: {} } },
  { name: "inspect_physical_execution", label: "Inspect physical execution", description: "Inspect recorded execution evidence for an exact known run. This does not prepare, approve, stop or execute equipment.", parameters: { type: "object", additionalProperties: false, properties: { runId: { type: "string", minLength: 1, maxLength: 128 } } } }
].map(({ name, label, description, parameters }) => {
  const schema2 = structuredClone(parameters);
  if (schema2.properties?.requestId)
    delete schema2.properties.requestId;
  if (schema2.required)
    schema2.required = schema2.required.filter((key) => key !== "requestId");
  return Object.freeze({ name, label, description: descriptions[name] || description, parameters: schema2 });
}));
var agentToolNames = Object.freeze(agentToolDefinitions.map((tool) => tool.name));

// ../harness-gripper-check/packages/operator-service/src/physical.js
function createPublicClients({ endpoint, credential = {}, fetchImpl = globalThis.fetch }) {
  return Object.freeze({
    node: createPhysicalNodeClient({ baseUrl: endpoint, fetchImpl }),
    camera: createCameraPreviewClient({ baseUrl: endpoint, token: credential.cameraToken, fetchImpl }),
    execution: createExecutionClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl }),
    commissioning: createCommissioningClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl }),
    setup: createSetupRequirementsClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl })
  });
}
function createPhysicalContext({ clients, experiments, now, onChange, canPrompt, sendIntent }) {
  let workflow = createPhysicalWorkflowState(clients.node.origin), workcell, setupView;
  let setupContext = { generation: 0, snapshot: null, capabilityCatalog: null, routeReceipt: null, routeRelationship: "none" };
  const transition = (event) => {
    const next = updatePhysicalWorkflow(workflow, event);
    if (next === workflow)
      return false;
    workflow = next;
    setupContext = {
      generation: setupContext.generation + 1,
      snapshot: workflow.snapshot,
      capabilityCatalog: workflow.capabilityCatalog,
      routeReceipt: workflow.routeReceipt,
      routeRelationship: workflow.routeReceipt ? "current" : "none"
    };
    setupView?.contextChanged();
    workcell?.setWorkflow(workflow);
    onChange();
    return true;
  };
  const setupInspector = createSetupInspector({
    client: { status: () => clients.execution.status() },
    requirementsClient: clients.setup,
    getContext: () => setupContext,
    now
  });
  setupView = createSetupView({ inspector: setupInspector, getContext: () => setupContext, now, onChange: () => workcell?.setupChanged() });
  const executionInspector = createExecutionInspector({
    client: clients.execution,
    now,
    getContext: () => ({ generation: workflow.generation, route: workflow.routeReceipt, selectedRun: workcell?.snapshot().execution.run || null })
  });
  const tools = createPhysicalTools({
    defineTool: (tool) => tool,
    client: clients.node,
    onSnapshot: (snapshot) => transition({ type: "snapshot", snapshot }),
    onIntent: (response, requestedIntent) => transition({ type: "intent", response, requestedIntent }),
    onError: (error) => transition({ type: "error", error }),
    onPlanError: (error, requestedIntent) => transition({ type: "plan-error", error, requestedIntent }),
    onCatalog: (catalog, generation) => transition({ type: "capability-catalog", catalog, generation }),
    onRoute: (receipt, generation) => transition({ type: "route", receipt, generation }),
    onRouteError: (error, generation) => transition({ type: "route-error", error, generation }),
    onRouteChecking: (type) => {
      transition({ type });
      return workflow.generation;
    }
  });
  workcell = createWorkcellController({
    workflow,
    cameraClient: clients.camera,
    executionClient: clients.execution,
    commissioningClient: clients.commissioning,
    now: () => new Date(now()).toISOString(),
    canPrompt,
    sendIntent,
    getExperiments: () => experiments,
    getSetupView: () => setupView.snapshot(),
    inspectSetup: () => setupView.inspect({}),
    invalidateWorkflow: () => transition({ type: "reset-intent" }),
    refreshWorkflow: async () => {
      await tools.find((tool) => tool.name === "inspect_physical_system").execute();
      await tools.find((tool) => tool.name === "inspect_physical_capabilities").execute("", {});
    }
  });
  const unsubscribe = workcell.subscribe(onChange);
  return Object.freeze({
    workcell,
    tools,
    clients,
    inspectSetup: (args, options) => setupView.inspect(args, options),
    inspectExecution: (args, options) => executionInspector.inspect(args, options),
    async dispose() {
      unsubscribe();
      setupView.dispose();
      executionInspector.dispose();
      await workcell.dispose();
    }
  });
}

// ../harness-gripper-check/packages/operator-service/src/service.js
var ACTIVE = new Set(["READY", "RUNNING", "OUTCOME_UNKNOWN"]);
var TERMINAL_RUN = new Set(["VERIFIED_SUCCESS", "FAILED", "CANCELLED", "BLOCKED"]);
var CONTINUATION_TEXT = "Continue the approved synthetic simulation experiment. Run the remaining trials, compare the measurements, and summarize the result.";
var clone3 = (value) => structuredClone(value);
var hash = (value) => createHash8("sha256").update(JSON.stringify(value)).digest("hex");
var checkpoint = (experiment2) => hash(experiment2.trials.map((trial) => [trial.id, trial.status]));
var fail3 = (code, message) => Object.assign(new Error(message), { code, operatorServiceError: true });
function text4(value, name, maximum = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value))
    throw fail3("INVALID_REQUEST", `${name} is invalid`);
  return value.trim();
}
function fields3(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key)))
    throw fail3("INVALID_REQUEST", "This request has unsupported or missing fields");
}
function clean(value) {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 1024 * 1024)
    throw fail3("INVALID_REQUEST", "The request is too large or invalid");
  const result = JSON.parse(json);
  const visit = (item, depth = 0) => {
    if (depth > 20)
      throw fail3("INVALID_REQUEST", "The request is too deeply nested");
    if (!item || typeof item !== "object")
      return;
    for (const [key, value2] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw fail3("INVALID_REQUEST", "Unsupported request field");
      visit(value2, depth + 1);
    }
  };
  visit(result);
  return result;
}
function requestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    throw fail3("INVALID_REQUEST", "A bounded unique request ID is required");
  return value;
}
function publicError(error) {
  return error?.operatorServiceError ? error : fail3("REQUEST_FAILED", experimentRequestFailure(error)?.message || workcellRequestFailure(error)?.message || "The request could not be confirmed. Inspect its current state before retrying.");
}
async function createManagedWorkspace(dataDir, id5) {
  let current = path4.parse(dataDir).root;
  for (const component of dataDir.slice(current.length).split(path4.sep).filter(Boolean)) {
    current = path4.join(current, component);
    const stat2 = await lstat(current);
    if (!stat2.isDirectory() || stat2.isSymbolicLink())
      throw fail3("WORKSPACE_UNAVAILABLE", "The managed workspace requires real directories without symbolic links. Preserve the existing folders and inspect the storage path.");
  }
  const root = path4.join(dataDir, "projects");
  try {
    await mkdir2(root, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw fail3("WORKSPACE_UNAVAILABLE", "The managed workspace requires a real directory without symbolic links. Preserve the existing folder and inspect its storage path.");
  const cwd = path4.join(root, id5);
  await mkdir2(cwd, { mode: 448 });
  return cwd;
}
async function createOperatorService({
  dataDir,
  secretStore,
  connections = exports_connections,
  clientFactory = createPublicClients,
  submitContinuation,
  now = Date.now,
  stepMs = 50,
  allowDeviceConnections = false,
  skillPackageRoot
} = {}) {
  if (!path4.isAbsolute(dataDir || ""))
    throw new TypeError("An isolated absolute operator data directory is required");
  await mkdir2(dataDir, { recursive: true, mode: 448 });
  const store = createExperimentStore({ storageDir: path4.join(dataDir, "operator-state"), sessionId: "operator-service-v1" });
  let saved;
  try {
    saved = store.read() || { schemaVersion: 1, revision: 0, projects: [], bindings: [], selection: { projectId: null, conversationId: null }, continuations: [], ownership: [] };
    fields3(saved, ["schemaVersion", "revision", "projects", "bindings", "selection", "continuations", "ownership"]);
    if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.projects) || saved.projects.length > 256 || !Array.isArray(saved.bindings) || saved.bindings.length > 1024 || !Array.isArray(saved.continuations) || saved.continuations.length > 4096 || !Array.isArray(saved.ownership) || saved.ownership.length > 2048)
      throw new Error("Invalid operator storage");
    const ids = new Set;
    for (const project3 of saved.projects) {
      fields3(project3, ["id", "name", "cwd", "generation", "connection"], ["id", "name", "cwd", "generation", "connection"]);
      fields3(project3.connection, ["type", "label", "nodeUrl", "host", "username", "port", "remotePort", "keyPath", "knownHostsPath", "credentialRef", "expectedNodeId"]);
      text4(project3.id, "Project ID");
      text4(project3.name, "Project name");
      if (ids.has(project3.id) || !path4.isAbsolute(project3.cwd))
        throw new Error("Invalid saved project");
      ids.add(project3.id);
      if (!["local", "ssh", "simulation"].includes(project3.connection?.type) || !Number.isSafeInteger(project3.generation) || project3.generation < 0)
        throw new Error("Invalid saved connection");
    }
    ids.clear();
    for (const binding2 of saved.bindings) {
      fields3(binding2, ["id", "projectId", "serverId", "sessionId", "title"], ["id", "projectId", "serverId", "sessionId", "title"]);
      text4(binding2.id, "Conversation ID");
      text4(binding2.serverId, "Server ID", 512);
      text4(binding2.sessionId, "Session ID", 256);
      if (ids.has(binding2.id) || !saved.projects.some((project3) => project3.id === binding2.projectId))
        throw new Error("Invalid saved binding");
      ids.add(binding2.id);
    }
    for (const record of saved.continuations) {
      fields3(record, ["conversationId", "requestId", "fingerprint", "status", "experimentId", "planDigest", "checkpoint"], ["conversationId", "requestId", "fingerprint", "status"]);
      requestId(record.requestId);
      if (!ids.has(record.conversationId) || !/^[0-9a-f]{64}$/.test(record.fingerprint) || !["PENDING", "UNCONFIRMED", "ACCEPTED"].includes(record.status))
        throw new Error("Invalid continuation evidence");
      if (record.experimentId !== undefined)
        text4(record.experimentId, "Saved experiment identity", 160);
      for (const field of ["planDigest", "checkpoint"])
        if (record[field] !== undefined && !/^[0-9a-f]{64}$/.test(record[field]))
          throw new Error("Invalid continuation binding");
    }
    for (const record of saved.ownership) {
      if (!ids.has(record.conversationId) || !saved.projects.some((project3) => project3.id === record.projectId) || !["camera", "execution", "commissioning"].includes(record.kind))
        throw new Error("Invalid ownership evidence");
      text4(record.nodeId, "Saved Node identity", 512);
      if (record.kind === "commissioning") {
        const status = normalizeGripperCheck(record.commissioningStatus);
        if (status.nodeSessionId !== record.nodeSessionId || status.trial?.trialId !== record.trialId || !commissioningUnresolved(status))
          throw new Error("Invalid commissioning ownership evidence");
      }
    }
    fields3(saved.selection, ["projectId", "conversationId"]);
    if (saved.selection.projectId && !saved.projects.some((project3) => project3.id === saved.selection.projectId))
      throw new Error("Invalid selection");
    if (saved.selection.conversationId && !saved.bindings.some((entry) => entry.id === saved.selection.conversationId && entry.projectId === saved.selection.projectId))
      throw new Error("Invalid selection");
  } catch {
    store.release();
    throw fail3("STORAGE_INVALID", "Operator metadata is invalid. Preserve the files and open a compatible service; no work was replayed.");
  }
  const serviceId = randomUUID5(), contexts = new Map, links = new Map, tokens = new Map, nodeOwners = new Map, endpointOwners = new Map, listeners = new Set, pendingProjects = new Map;
  const recoveryControllers = new Map;
  const recoveryKey = (record) => JSON.stringify([record.projectId, record.conversationId, record.nodeSessionId, record.trialId]);
  const recoveryView = (record) => {
    const controller = recoveryControllers.get(recoveryKey(record));
    const view = controller?.controller.snapshot() || {
      status: record.commissioningStatus,
      available: false,
      fresh: false,
      receivedAt: null,
      maximumAgeMs: 5000,
      recoveryStatus: null,
      recoveryAvailable: false,
      recoveryFresh: false,
      recoveryReceivedAt: null,
      pending: null,
      stopPending: false,
      message: null,
      unresolved: true
    };
    const link = links.get(record.projectId);
    return link?.status === "connected" && fresh(link.observedAt) && (!controller || controller.generation === project2(record.projectId).generation) ? view : { ...view, recoveryAvailable: false, recoveryFresh: false, recoveryReceivedAt: null };
  };
  const secrets = secretStore || createNativeSecretStore({ configDir: path4.join(dataDir, "credentials") });
  let closed = false, closing = false, closePromise, storageFailed = false, revision = 0, catalogPending = false, skillTool;
  const project2 = (id5) => saved.projects.find((item) => item.id === id5);
  const binding = (id5) => saved.bindings.find((item) => item.id === id5);
  const fresh = (at) => Number.isFinite(at) && now() >= at && now() - at < 1e4;
  const bindingScope = (entry) => ({ projectId: entry.projectId, conversationId: entry.id, serverId: entry.serverId, sessionId: entry.sessionId, connectionGeneration: project2(entry.projectId).generation });
  const save = () => {
    if (storageFailed)
      throw fail3("STORAGE_UNAVAILABLE", "Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.");
    saved.revision += 1;
    try {
      store.write(saved);
    } catch {
      storageFailed = true;
      throw fail3("STORAGE_UNAVAILABLE", "Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.");
    }
  };
  const unresolved = (view) => Boolean(view?.camera?.pending || view?.camera?.stopPending || view?.camera?.stopUnconfirmed || view?.camera?.stopCaptureSessionId || view?.commissioning?.unresolved || view?.commissioning?.pending || view?.commissioning?.stopPending || view?.execution?.pending || view?.execution?.stopPending || [...view?.execution?.activeRuns || [], ...view?.execution?.runs || [], ...view?.execution?.run ? [view.execution.run] : []].some((run) => !TERMINAL_RUN.has(run.phase) || run.stopStatus === "STOP_UNCONFIRMED"));
  const requiresRecovery = (record) => record.recovered || record.status === "OUTCOME_UNKNOWN" && !(record.kind === "camera" ? record.captureSessionId : record.kind === "commissioning" ? record.trialId : record.runId);
  const recoveryOwner = (record) => ({
    ...record,
    ...bindingScope(binding(record.conversationId)),
    projectName: project2(record.projectId).name,
    statusUnavailable: true,
    ...!(record.kind === "camera" ? record.captureSessionId : record.kind === "commissioning" ? record.trialId : record.runId) ? {
      error: "The operation acknowledgement did not include an identity. Its outcome is unknown. Inspect the original Node and retain its evidence; another camera or run cannot safely be guessed."
    } : {}
  });
  const experimentView = (context, entry) => {
    if (!context || !entry)
      return null;
    const view = context.experiments.snapshot(), current = view.current;
    const latest = current && saved.continuations.findLast((record) => record.conversationId === entry.id && record.fingerprint === hash([entry.id, current.id, current.planDigest]));
    return { ...view, continuation: latest ? {
      requestId: latest.requestId,
      status: latest.status,
      experimentId: latest.experimentId || current.id,
      planDigest: latest.planDigest || current.planDigest,
      checkpoint: latest.checkpoint || checkpoint(current)
    } : null };
  };
  function snapshot() {
    const selected = binding(saved.selection.conversationId), context = contexts.get(selected?.id), selectedProject = project2(saved.selection.projectId);
    const selectedLink = links.get(selectedProject?.id), ownsView = Boolean(selected && selectedLink?.physicalOwner === selected.id);
    const view = ownsView ? selectedLink.physical?.workcell.snapshot() : null;
    const connected = selectedLink?.status === "connected" && fresh(selectedLink.observedAt);
    const workcell = view && !connected ? {
      ...view,
      camera: { ...view.camera, availability: "unavailable", frame: null, previewFrameId: null, receivedAt: null },
      execution: { ...view.execution, availability: "unavailable", canPrepare: false, canApprove: false },
      commissioning: view.commissioning ? { ...view.commissioning, available: false, fresh: false, receivedAt: null } : null
    } : view;
    const owners = [...links].flatMap(([id5, link]) => {
      const owner = binding(link.physicalOwner), view2 = link.physical?.workcell.snapshot();
      if (!owner || !view2)
        return [];
      return [{
        projectId: id5,
        projectName: project2(id5).name,
        conversationId: owner.id,
        serverId: owner.serverId,
        sessionId: owner.sessionId,
        connectionGeneration: project2(id5).generation,
        statusUnavailable: link.status !== "connected" || !fresh(link.observedAt),
        view: view2
      }];
    });
    return clone3({
      schemaVersion: 1,
      serviceId,
      revision,
      error: storageFailed ? "Operator evidence could not be saved; work is blocked." : null,
      deviceConnectionsEnabled: allowDeviceConnections,
      activeProjectId: selectedProject?.id || null,
      activeConversationId: selected?.id || null,
      connectionGeneration: selectedProject?.generation || 0,
      projects: saved.projects.map((item) => {
        const link = links.get(item.id), status = link?.status === "connected" && item.connection.type !== "simulation" && !fresh(link.observedAt) ? "reconnecting" : link?.status || "offline";
        const camera = link?.physical?.workcell.snapshot().camera, observation = link?.observation;
        return {
          id: item.id,
          name: item.name,
          cwd: item.cwd,
          connection: {
            kind: item.connection.type,
            label: item.connection.label,
            status,
            observedAt: link?.observedAt ? new Date(link.observedAt).toISOString() : null,
            deviceCount: status === "connected" && item.connection.type === "simulation" ? 0 : status === "connected" && fresh(Date.parse(observation?.discovery?.observedAt)) ? observation.discovery.devices.filter((device) => device.detected).length : null,
            inUseCount: status === "connected" && cameraIsFresh(camera, now()) ? 1 : null,
            error: link?.error || null
          },
          conversations: saved.bindings.filter((entry) => entry.projectId === item.id).map(({ id: id5, title, serverId, sessionId }) => ({ id: id5, title, serverId, sessionId }))
        };
      }),
      conversation: selected ? {
        id: selected.id,
        title: selected.title,
        serverId: selected.serverId,
        sessionId: selected.sessionId,
        busy: Boolean(context?.busy),
        error: context?.error || null
      } : null,
      experiments: experimentView(context, selected),
      workcell,
      setupReport: workcell?.setup?.report || null,
      activeExperiments: [...contexts].flatMap(([id5, entry]) => {
        const current = entry.experiments.snapshot().current, owner = binding(id5);
        return ACTIVE.has(current?.phase) ? [{ ...bindingScope(owner), projectName: project2(owner.projectId).name, experiment: current, canStop: true }] : [];
      }),
      activeCaptures: [
        ...owners.filter(({ view: view2 }) => view2.camera.stopCaptureSessionId || view2.camera.pending).map(({ view: view2, ...owner }) => ({
          ...owner,
          captureSessionId: view2.camera.stopCaptureSessionId,
          pending: view2.camera.pending,
          stopPending: view2.camera.stopPending,
          stopUnconfirmed: view2.camera.stopUnconfirmed,
          canStop: !view2.camera.stopPending
        })),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === "camera").map((record) => ({
          ...recoveryOwner(record),
          stopUnconfirmed: true,
          canStop: Boolean(record.captureSessionId && links.get(record.projectId)?.status === "connected")
        }))
      ],
      activeRuns: [
        ...owners.flatMap(({ view: view2, ...owner }) => (view2.execution.activeRuns || []).map((run) => ({ ...owner, run, canStop: !view2.execution.stopPending }))),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === "execution").map((record) => ({
          ...recoveryOwner(record),
          run: { runId: record.runId, runDigest: record.runDigest, phase: "OUTCOME_UNKNOWN" },
          canStop: Boolean(record.runId && links.get(record.projectId)?.status === "connected")
        }))
      ],
      activeCommissioning: [
        ...owners.filter(({ view: view2 }) => view2.commissioning?.unresolved).map(({ view: view2, ...owner }) => ({
          ...owner,
          statusUnavailable: owner.statusUnavailable || !view2.commissioning.fresh,
          status: view2.commissioning.status,
          trialId: view2.commissioning.status?.trial?.trialId || null,
          nodeSessionId: view2.commissioning.status?.nodeSessionId || null,
          recoveryStatus: view2.commissioning.recoveryStatus,
          recoveryView: view2.commissioning,
          canStop: Boolean(view2.commissioning.status?.trial && !view2.commissioning.stopPending),
          stopPending: view2.commissioning.stopPending
        })),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === "commissioning").map((record) => ({
          ...recoveryOwner(record),
          status: record.commissioningStatus || null,
          recoveryStatus: recoveryView(record).recoveryStatus,
          recoveryView: recoveryView(record),
          trialId: record.trialId || null,
          nodeSessionId: record.nodeSessionId || null,
          stopPending: false,
          canStop: Boolean(record.trialId && record.nodeSessionId && links.get(record.projectId)?.status === "connected")
        }))
      ],
      recoveryOperations: saved.ownership.filter(requiresRecovery).map(recoveryOwner)
    });
  }
  const emit = () => {
    if (closed)
      return;
    revision += 1;
    const state2 = snapshot();
    for (const listener of listeners) {
      try {
        listener(state2);
      } catch {}
    }
  };
  function openContext(entry) {
    if (contexts.has(entry.id))
      return contexts.get(entry.id);
    const experiments = createExperimentController({ sessionId: entry.id, storageDir: path4.join(dataDir, "experiments"), now, stepMs });
    const context = { experiments, busy: false, error: null, mutation: null, stopEpoch: 0, physicalStopEpoch: 0, continuation: null, agentToken: randomBytes(32).toString("hex") };
    context.tools = createExperimentTools({ getController: () => experiments });
    context.unsubscribe = experiments.subscribe(emit);
    contexts.set(entry.id, context);
    return context;
  }
  try {
    for (const entry of saved.bindings)
      openContext(entry);
    for (const record of saved.continuations)
      if (record.status === "PENDING")
        record.status = "UNCONFIRMED";
    for (const record of saved.ownership) {
      record.recovered = true;
      if (nodeOwners.has(record.nodeId) && nodeOwners.get(record.nodeId) !== record.projectId)
        throw fail3("STORAGE_INVALID", "Saved Node ownership conflicts; preserve the records");
      nodeOwners.set(record.nodeId, record.projectId);
    }
    save();
  } catch (error) {
    for (const context of contexts.values())
      await context.experiments.dispose();
    store.release();
    throw publicError(error);
  }
  function scope(body, { physical: physical2 = false, selected = false, generation = true } = {}) {
    const entry = binding(body.conversationId), p = project2(body.projectId);
    if (!p || !entry || entry.projectId !== p.id || body.serverId !== undefined && entry.serverId !== body.serverId || body.sessionId !== undefined && entry.sessionId !== body.sessionId)
      throw fail3("SCOPE_CHANGED", "The conversation binding changed. Open the exact project and conversation before acting.");
    if (generation && (!Number.isSafeInteger(body.connectionGeneration) || body.connectionGeneration !== p.generation))
      throw fail3("CONNECTION_CHANGED", "The connection changed. Refresh and review the current project state.");
    if (selected && (saved.selection.projectId !== p.id || saved.selection.conversationId !== entry.id))
      throw fail3("SCOPE_CHANGED", "The selected conversation changed. Review its current proposal before acting.");
    if (physical2 && (links.get(p.id)?.status !== "connected" || !fresh(links.get(p.id)?.observedAt)))
      throw fail3("CONNECTION_UNAVAILABLE", "Explicitly connect this project and refresh its status before using devices.");
    return { entry, p, context: contexts.get(entry.id) };
  }
  const ensureOpen = (stop = false) => {
    if (closed)
      throw fail3("SERVICE_CLOSED", "The operator service is closed");
    if (closing && !stop)
      throw fail3("SERVICE_CLOSING", "The operator service is closing. No new work can start during cleanup.");
    if (storageFailed && !stop)
      throw fail3("STORAGE_UNAVAILABLE", "Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.");
  };
  async function withContext(context, independent, action) {
    if (!independent && context.mutation)
      throw fail3("REQUEST_PENDING", "Another request in this conversation is in progress; Stop remains available.");
    const token = {};
    if (!independent)
      context.mutation = token;
    try {
      return await action();
    } finally {
      if (context.mutation === token)
        context.mutation = null;
    }
  }
  async function continueExperiment(owner, body, approve) {
    const { entry, context, p } = owner, epoch = context.stopEpoch;
    const reviewed = (ready = true) => {
      ensureOpen();
      scope(body, { selected: true });
      const state2 = context.experiments.snapshot(), current2 = state2.current;
      if (context.stopEpoch !== epoch)
        throw fail3("STOP_REQUESTED", "Stop was requested. No continuation will resume this experiment.");
      if (state2.error)
        throw fail3("STORAGE_UNAVAILABLE", state2.error);
      if (!current2 || current2.id !== body.experimentId || current2.planDigest !== body.expectedDigest)
        throw fail3("PLAN_CHANGED", "The experiment does not match the reviewed plan. Refresh its exact goal and trial budget.");
      if (current2.mode !== "simulation" || current2.phase === "OUTCOME_UNKNOWN" || current2.stopStatus === "UNCONFIRMED")
        throw fail3("OUTCOME_UNKNOWN", "This experiment is unavailable or its outcome is unconfirmed. Use Stop and retain its evidence.");
      if (now() >= current2.expiresAt)
        throw fail3("APPROVAL_EXPIRED", "This experiment approval has expired. Stop it and propose a new bounded experiment.");
      if (ready && (current2.phase !== "READY" || !Number.isFinite(current2.approvedAt)))
        throw fail3("APPROVAL_REQUIRED", "Review and approve this exact simulation proposal before continuing.");
      return current2;
    };
    requestId(body.requestId);
    if (approve && body.approved !== true)
      throw fail3("APPROVAL_REQUIRED", "Review and explicitly approve this exact synthetic experiment.");
    const current = reviewed(false), fingerprint = hash([entry.id, body.experimentId, body.expectedDigest]);
    let record = saved.continuations.find((item) => item.conversationId === entry.id && item.requestId === body.requestId);
    const retry = Boolean(record);
    if (record && record.fingerprint !== fingerprint)
      throw fail3("REQUEST_CONFLICT", "This request ID was used for a different experiment action.");
    const response = (accepted, duplicate, error) => ({ ...context.experiments.snapshot(), continuation: { accepted, duplicate, requestId: body.requestId, mode: "model", ...error ? { error } : {} } });
    if (record?.status === "ACCEPTED") {
      if (!["READY", "RUNNING", "COMPLETED"].includes(current.phase))
        throw fail3("APPROVAL_REQUIRED", "This experiment is stopped or interrupted; it cannot resume.");
      return response(true, true);
    }
    if (!approve)
      reviewed();
    if (!record && saved.continuations.some((item) => item.conversationId === entry.id && item.fingerprint === fingerprint && ["PENDING", "UNCONFIRMED"].includes(item.status))) {
      throw fail3("CONTINUATION_UNCONFIRMED", "A continuation for this exact plan is still unconfirmed. Check the retained request or use Stop; do not submit another continuation with a new request ID.");
    }
    if (context.busy)
      throw fail3("AGENT_BUSY", "Wait for the current assistant request to finish or cancel it before continuing.");
    if (current.trials.length >= current.trialLimit)
      throw fail3("TRIAL_LIMIT_REACHED", "The approved trial limit has been reached. Finish this experiment.");
    if (!record && (saved.continuations.length >= 4096 || saved.continuations.filter((item) => item.conversationId === entry.id).length >= 256))
      throw fail3("REQUEST_LIMIT", "The continuation request limit is reached. Finish or Stop and start a new conversation.");
    if (approve && current.phase !== "READY")
      context.experiments.approve({ experimentId: body.experimentId, expectedDigest: body.expectedDigest });
    reviewed();
    if (!record) {
      record = {
        conversationId: entry.id,
        requestId: body.requestId,
        fingerprint,
        status: "PENDING",
        experimentId: current.id,
        planDigest: current.planDigest,
        checkpoint: checkpoint(current)
      };
      saved.continuations.push(record);
    }
    record.experimentId ||= current.id;
    record.planDigest ||= current.planDigest;
    record.checkpoint ||= checkpoint(current);
    record.status = "PENDING";
    save();
    emit();
    const controller = new AbortController;
    context.continuation = controller;
    try {
      reviewed();
      if (!submitContinuation)
        throw fail3("AGENT_UNAVAILABLE", "The OpenCode conversation is unavailable. Approval is saved; reconnect it before choosing Continue.");
      const accepted = await submitContinuation({ binding: bindingScope(entry), text: CONTINUATION_TEXT, requestId: body.requestId, retry, signal: controller.signal });
      if (accepted?.accepted !== true) {
        record.status = "UNCONFIRMED";
        save();
        emit();
        return response(false, false, accepted?.error || "The assistant did not confirm accepting the continuation. Inspect its status before retrying with this request ID.");
      }
      record.status = "ACCEPTED";
      save();
      emit();
      return response(true, Boolean(accepted.duplicate));
    } catch (error) {
      record.status = "UNCONFIRMED";
      if (!storageFailed)
        save();
      emit();
      return response(false, false, publicError(error).message);
    } finally {
      if (context.continuation === controller)
        context.continuation = null;
    }
  }
  async function connect(p) {
    if (pendingProjects.has(p.id))
      throw fail3("CONNECTION_PENDING", "This project connection is being checked.");
    if (p.connection.type !== "simulation" && !allowDeviceConnections)
      throw fail3("DEVICE_CONNECTIONS_DISABLED", "Device connections are disabled in this isolated review service. Synthetic experiments remain available.");
    const prior = links.get(p.id);
    if (prior?.status === "connected" && fresh(prior.observedAt))
      return snapshot();
    const task = {};
    pendingProjects.set(p.id, task);
    let attached;
    try {
      if (p.connection.type === "simulation") {
        links.set(p.id, { status: "connected", observedAt: now(), error: null });
        emit();
        return snapshot();
      }
      if (prior?.physical && unresolved(prior.physical.workcell.snapshot()) && !prior.endpoint)
        throw fail3("OWNERSHIP_UNRESOLVED", "The original connection has unresolved operations. Retain its owner and inspect recovery.");
      const key = p.connection.type === "ssh" ? `ssh:${p.connection.username}@${p.connection.host}:${p.connection.port || 22}:${p.connection.remotePort || 8876}` : connections.normalizeLocalEndpoint(p.connection.nodeUrl).replace("localhost", "127.0.0.1");
      if (endpointOwners.has(key) && endpointOwners.get(key) !== p.id)
        throw fail3("NODE_OWNED", "This Node endpoint already belongs to another project.");
      const credential = p.connection.credentialRef ? JSON.parse(await secrets.read(p.connection.credentialRef) || "null") : null;
      const probeNode = async ({ endpoint, expectedNodeId }) => {
        const clients = clientFactory({ endpoint, credential: credential || {} });
        const [observation] = await Promise.all([clients.node.inspect(), clients.camera.status()]);
        if (expectedNodeId && observation.nodeName !== expectedNodeId)
          throw fail3("NODE_CHANGED", "The responding Node identity changed. Retain the original project owner.");
        return { authenticated: true, nodeId: observation.nodeName, observation };
      };
      clearTimeout(prior?.timer);
      if (prior?.endpoint && !prior.transportLost)
        attached = { ...prior, identity: await probeNode({ endpoint: prior.endpoint, expectedNodeId: p.connection.expectedNodeId }) };
      else {
        if (prior?.endpoint)
          await prior.close?.();
        attached = await (p.connection.type === "ssh" ? connections.attachSSH : connections.attachLocal)(p.connection, {
          credentialResolver: async () => credential,
          probeNode,
          ...prior?.endpoint ? { allocatePort: async () => Number(new URL(prior.endpoint).port) } : {}
        });
      }
      if (!attached.identity?.authenticated || !attached.identity.nodeId || nodeOwners.has(attached.identity.nodeId) && nodeOwners.get(attached.identity.nodeId) !== p.id) {
        await attached.close?.();
        throw fail3("NODE_OWNED", "The authenticated Node is unavailable or owned by another project.");
      }
      if (p.connection.expectedNodeId && p.connection.expectedNodeId !== attached.identity.nodeId) {
        await attached.close?.();
        throw fail3("NODE_CHANGED", "The responding Node identity changed.");
      }
      p.connection.expectedNodeId = attached.identity.nodeId;
      if (!prior)
        p.generation += 1;
      save();
      const link = {
        ...prior,
        ...attached,
        credential,
        clients: clientFactory({ endpoint: attached.endpoint, credential: credential || {} }),
        key,
        status: "connected",
        observedAt: now(),
        observation: attached.identity.observation,
        error: null,
        transportLost: false
      };
      prior?.offDisconnect?.();
      link.offDisconnect = attached.onDisconnect?.(() => {
        link.status = "offline";
        link.observedAt = null;
        link.transportLost = true;
        link.error = "Connection lost. Owned outcomes remain unresolved until the same Node is inspected.";
        emit();
      });
      links.set(p.id, link);
      endpointOwners.set(key, p.id);
      nodeOwners.set(attached.identity.nodeId, p.id);
      let failures = 0;
      const monitor = async () => {
        if (closed || links.get(p.id) !== link || link.transportLost)
          return;
        try {
          const identity3 = await probeNode({ endpoint: link.endpoint, expectedNodeId: p.connection.expectedNodeId });
          if (closed || links.get(p.id) !== link || link.transportLost)
            return;
          link.status = "connected";
          link.observedAt = now();
          link.observation = identity3.observation;
          link.error = null;
          failures = 0;
        } catch (error) {
          if (closed || links.get(p.id) !== link)
            return;
          failures += 1;
          link.status = failures >= 5 ? "offline" : "reconnecting";
          link.error = publicError(error).message;
        }
        emit();
        if (!closed && links.get(p.id) === link && failures < 5) {
          link.timer = setTimeout(monitor, Math.min(4000 * 2 ** failures, 30000));
          link.timer.unref?.();
        }
      };
      link.timer = setTimeout(monitor, 4000);
      link.timer.unref?.();
      emit();
      return snapshot();
    } catch (error) {
      const retained = links.get(p.id) || prior;
      const cleanup = attached || error?.connection;
      if (cleanup && cleanup !== retained) {
        try {
          await cleanup.close?.();
        } catch {
          links.set(p.id, { ...retained, ...cleanup, status: "offline", error: "Connection cleanup is unconfirmed. Retry Disconnect before replacing its owner." });
        }
      }
      if (retained) {
        retained.status = "offline";
        retained.error = publicError(error).message;
      }
      emit();
      throw error;
    } finally {
      if (pendingProjects.get(p.id) === task)
        pendingProjects.delete(p.id);
    }
  }
  function journalPhysical(p, entry, link) {
    const view = link.physical?.workcell.snapshot();
    if (!view)
      return;
    const retained = saved.ownership.filter((record) => record.projectId !== p.id || requiresRecovery(record) || record.kind === "camera" && !record.captureSessionId && view.camera.error || record.kind === "execution" && !record.runId && view.execution.error).map((record) => record.projectId === p.id && !record.recovered && (record.kind === "camera" && !record.captureSessionId && view.camera.error && !view.camera.pending || record.kind === "execution" && !record.runId && view.execution.error && !view.execution.pending) ? { ...record, status: "OUTCOME_UNKNOWN" } : record);
    const base2 = { projectId: p.id, conversationId: entry.id, nodeId: p.connection.expectedNodeId, connectionGeneration: p.generation, recovered: false };
    if (view.camera.stopCaptureSessionId || view.camera.pending || view.camera.stopUnconfirmed)
      retained.push({ ...base2, kind: "camera", captureSessionId: view.camera.stopCaptureSessionId || null, status: view.camera.status?.phase || "OUTCOME_UNKNOWN" });
    for (const run of view.execution.activeRuns || []) {
      const exact2 = view.execution.run?.runId === run.runId ? view.execution.run : run;
      const pins = Object.fromEntries(["runId", "mode", "capabilityId", "implementationId", "implementationDigest", "configurationId", "configurationDigest", "routeReceiptDigest", "snapshotDigest", "inputs", "approval"].filter((key) => Object.hasOwn(exact2, key)).map((key) => [key, exact2[key]]));
      retained.push({ ...base2, kind: "execution", runId: run.runId, runDigest: run.runDigest, pins, status: run.phase });
    }
    if (view.commissioning?.status?.trial && view.commissioning.unresolved)
      retained.push({
        ...base2,
        kind: "commissioning",
        trialId: view.commissioning.status.trial.trialId,
        nodeSessionId: view.commissioning.status.nodeSessionId,
        commissioningStatus: { ...view.commissioning.status, ...Object.hasOwn(view.commissioning.status, "recovery") ? { recovery: null, canConfirmRecovery: false } : {} },
        status: view.commissioning.status.trial.phase
      });
    if (view.execution.pending && !retained.some((record) => record.projectId === p.id && record.kind === "execution"))
      retained.push({ ...base2, kind: "execution", runId: null, status: "REQUEST_PENDING" });
    if (JSON.stringify(retained) !== JSON.stringify(saved.ownership)) {
      saved.ownership = retained;
      try {
        save();
      } catch {}
    }
    emit();
  }
  async function physicalContext(owner) {
    const { p, entry, context } = owner, link = links.get(p.id);
    if (!link?.clients)
      throw fail3("DEVICE_UNAVAILABLE", "This project has no connected device client. The arithmetic synthetic fixture does not provide cameras or hardware.");
    if (saved.ownership.some((record) => record.projectId === p.id && requiresRecovery(record)))
      throw fail3("RECOVERY_REQUIRED", "The service retained unresolved physical ownership. Inspect the original Node and resolve its exact operation before creating another controller.");
    if (link.physicalOwner !== entry.id) {
      if (link.physical && unresolved(link.physical.workcell.snapshot()))
        throw fail3("NODE_BUSY", `Another conversation owns this Node's active operation. Open its conversation or use its independent Stop.`);
      link.leave?.();
      await link.physical?.dispose();
      link.physicalOwner = entry.id;
      link.physical = createPhysicalContext({
        clients: link.clients,
        experiments: context.experiments,
        now,
        canPrompt: () => !context.busy,
        sendIntent: (text5) => submitContinuation?.({ binding: bindingScope(entry), text: text5, requestId: `intent-${randomUUID5()}` }),
        onChange: () => journalPhysical(p, entry, link)
      });
      link.leave = link.physical.workcell.onViewerConnect();
    }
    return link.physical;
  }
  async function withPhysical(owner, independent, action) {
    const { p, entry, context } = owner, link = links.get(p.id), epoch = context.physicalStopEpoch;
    if (!link)
      throw fail3("CONNECTION_UNAVAILABLE", "The owned project connection is unavailable");
    if (!independent && link.mutation)
      throw fail3("NODE_BUSY", "Another conversation is using this Node. Wait for that request; Stop remains available.");
    if (independent && link.physicalOwner !== entry.id && link.pendingOwner !== entry.id)
      throw fail3("SCOPE_CHANGED", "This conversation does not own the current device operation");
    const token = {};
    if (!independent) {
      link.mutation = token;
      link.pendingOwner = entry.id;
    }
    try {
      const physical2 = await physicalContext(owner);
      if (!independent && context.physicalStopEpoch !== epoch)
        throw fail3("STOP_REQUESTED", "Stop was requested before the device action started");
      ensureOpen(independent);
      return await action(physical2);
    } finally {
      if (link.mutation === token) {
        link.mutation = null;
        link.pendingOwner = null;
      }
    }
  }
  async function recoveredStop(owner, operation, body) {
    const { p, entry } = owner, link = links.get(p.id);
    const record = saved.ownership.find((item) => item.recovered && item.projectId === p.id && item.conversationId === entry.id && (operation === "camera.stop" ? item.kind === "camera" && item.captureSessionId === body.expectedCaptureSessionId : operation === "commissioning.stop" ? item.kind === "commissioning" && item.trialId === body.trialId : item.kind === "execution" && item.runId === body.runId));
    if (!record)
      return null;
    if (!link?.clients || link.status !== "connected" || p.connection.expectedNodeId !== record.nodeId)
      throw fail3("RECOVERY_REQUIRED", "Reconnect the exact original Node before retrying its owned Stop");
    let confirmed = false;
    if (record.kind === "camera") {
      const status = await link.clients.camera.stop({ expectedCaptureSessionId: record.captureSessionId });
      confirmed = status.phase === "stopped" && status.captureSessionId === record.captureSessionId;
    } else if (record.kind === "commissioning") {
      const retained = recoveryControllers.get(recoveryKey(record));
      const [original, cancellation] = await Promise.allSettled([
        link.clients.commissioning.stop({ expectedNodeSessionId: record.nodeSessionId, trialId: record.trialId, reason: "operator-requested-stop" }),
        retained?.controller.cancelRecovery()
      ]);
      if (original.status === "rejected")
        throw original.reason;
      if (cancellation.status === "rejected")
        throw cancellation.reason;
      const status = original.value;
      assertGripperCheckMatches(status, record.commissioningStatus);
      if (gripperRecoveryCleared(status, record.commissioningStatus))
        throw fail3("RECOVERY_REQUIRED", "Inspect the durable recovery receipt separately; Stop does not acknowledge clearance");
      confirmed = status.nodeSessionId === record.nodeSessionId && status.trial?.trialId === record.trialId && status.trial.digest === record.commissioningStatus?.trial?.digest && !commissioningUnresolved(status);
    } else {
      const run = await link.clients.execution.stop(record.runId, { reason: "operator-requested-stop" }, record.pins || { runId: record.runId });
      assertRunMatches(run, { ...record.pins, runId: record.runId });
      confirmed = TERMINAL_RUN.has(run.phase) && run.stopStatus === "STOP_CONFIRMED";
    }
    if (!confirmed) {
      emit();
      throw fail3("STOP_UNCONFIRMED", "Stop could not be confirmed for the retained operation. Its ownership is preserved; inspect the same Node and retry Stop.");
    }
    if (confirmed) {
      saved.ownership = saved.ownership.filter((item) => item !== record);
      if (!storageFailed)
        save();
    }
    emit();
    return snapshot();
  }
  async function recoveredCommissioning(owner, operation, body) {
    const { p, entry, context } = owner, link = links.get(p.id);
    const record = saved.ownership.find((item) => requiresRecovery(item) && item.kind === "commissioning" && item.projectId === p.id && item.conversationId === entry.id && item.trialId === body.trialId);
    if (!record)
      return null;
    scope(body, { physical: true, selected: true });
    if (!link?.clients || p.connection.expectedNodeId !== record.nodeId || body.trialDigest !== record.commissioningStatus?.trial?.digest)
      throw fail3("RECOVERY_REQUIRED", "Reconnect the exact original Node and review its retained gripper trial");
    return withContext(context, false, async () => {
      if (link.mutation)
        throw fail3("NODE_BUSY", "Another request owns this Node; wait for it to settle before recovery");
      const token = {};
      link.mutation = token;
      link.pendingOwner = entry.id;
      const key = recoveryKey(record);
      let retained = recoveryControllers.get(key);
      if (retained && (retained.generation !== p.generation || retained.client !== link.clients.commissioning)) {
        retained.controller.dispose();
        recoveryControllers.delete(key);
        retained = null;
      }
      if (!retained) {
        const controller = createCommissioningController({
          client: link.clients.commissioning,
          initialStatus: record.commissioningStatus,
          recoveryOnly: true,
          now,
          onChange: emit,
          canAct: () => {
            try {
              scope(body, { physical: true, selected: true });
              return !context.busy && saved.ownership.includes(record) && p.connection.expectedNodeId === record.nodeId;
            } catch {
              return false;
            }
          }
        });
        retained = { controller, generation: p.generation, client: link.clients.commissioning };
        recoveryControllers.set(key, retained);
      }
      const { projectId, conversationId, serverId, sessionId, connectionGeneration, ...payload } = body;
      try {
        await retained.controller.action(operation.slice(14), payload);
        const view = retained.controller.snapshot();
        if (!view.unresolved && gripperRecoveryCleared(view.status, record.commissioningStatus)) {
          const before = saved.ownership;
          if (!before.includes(record))
            throw fail3("OWNERSHIP_CHANGED", "Retained gripper ownership changed during recovery");
          saved.ownership = before.filter((item) => item !== record);
          try {
            save();
          } catch (error) {
            saved.ownership = before;
            throw error;
          }
          retained.controller.dispose();
          recoveryControllers.delete(key);
          const physical2 = await physicalContext(owner);
          await physical2.workcell.commissioningAction("refresh", {});
        }
        emit();
        return snapshot();
      } finally {
        if (link.mutation === token) {
          link.mutation = null;
          link.pendingOwner = null;
        }
      }
    });
  }
  async function command(name, input = {}) {
    const independent = name.endsWith(".stop") || name === "workcell.camera.frame" || name === "session.agentState";
    try {
      ensureOpen(independent);
      const body = clean(input);
      if (name === "project.create") {
        fields3(body, ["name", "cwd", "connection"], ["name", "connection"]);
        if (catalogPending)
          throw fail3("REQUEST_PENDING", "A project update is pending");
        catalogPending = true;
        try {
          if (saved.projects.length >= 256)
            throw fail3("PROJECT_LIMIT", "The project limit is reached");
          const connection = body.connection;
          fields3(connection, ["type", "label", "nodeUrl", "host", "username", "port", "remotePort", "keyPath", "knownHostsPath"], ["type"]);
          if (!["simulation", "local", "ssh"].includes(connection.type))
            throw fail3("INVALID_CONNECTION", "Choose simulation, local or SSH");
          if (connection.type === "local")
            connection.nodeUrl = connections.normalizeLocalEndpoint(connection.nodeUrl);
          if (connection.type === "ssh")
            buildSshArgs({ ...connection, remotePort: connection.remotePort || 8876 }, 1);
          const id5 = `project-${randomUUID5()}`, name2 = text4(body.name, "Project name");
          const cwd = body.cwd ? path4.resolve(text4(body.cwd, "Project folder", 2000)) : await createManagedWorkspace(dataDir, id5);
          if (body.cwd)
            await mkdir2(cwd, { recursive: true, mode: 448 });
          saved.projects.push({
            id: id5,
            name: name2,
            cwd,
            generation: 0,
            connection: { ...connection, label: text4(connection.label || (connection.type === "simulation" ? "Synthetic simulation" : connection.type === "ssh" ? connection.host : "This computer"), "Connection label") }
          });
          saved.selection = { projectId: id5, conversationId: null };
          save();
          if (connection.type === "simulation")
            links.set(id5, { status: "connected", observedAt: now(), error: null });
          emit();
          return snapshot();
        } finally {
          catalogPending = false;
        }
      }
      if (name === "session.bind") {
        fields3(body, ["projectId", "serverId", "sessionId", "title", "activate"], ["projectId", "serverId", "sessionId"]);
        if (body.activate !== undefined && typeof body.activate !== "boolean")
          throw fail3("INVALID_REQUEST", "Session activation must be an explicit boolean");
        const p = project2(body.projectId);
        if (!p)
          throw fail3("PROJECT_CHANGED", "Select an existing project");
        const serverId = text4(body.serverId, "OpenCode server identity", 512), sessionId = text4(body.sessionId, "OpenCode session identity", 256);
        let entry = saved.bindings.find((item) => item.serverId === serverId && item.sessionId === sessionId);
        if (entry && entry.projectId !== p.id)
          throw fail3("SESSION_OWNED", "This OpenCode session already belongs to another physical project");
        if (!entry) {
          if (saved.bindings.length >= 1024)
            throw fail3("SESSION_LIMIT", "The conversation binding limit is reached");
          entry = { id: `conversation-${randomUUID5()}`, projectId: p.id, serverId, sessionId, title: text4(body.title || "New conversation", "Conversation title") };
          saved.bindings.push(entry);
          save();
          openContext(entry);
        }
        if (body.activate !== false) {
          saved.selection = { projectId: p.id, conversationId: entry.id };
          save();
        }
        const agentToken = contexts.get(entry.id).agentToken;
        tokens.set(agentToken, entry.id);
        emit();
        return { binding: bindingScope(entry), agentToken, snapshot: snapshot() };
      }
      if (name === "project.select" || name === "session.select") {
        fields3(body, ["projectId", "conversationId"], ["projectId"]);
        const p = project2(body.projectId), entry = body.conversationId ? binding(body.conversationId) : saved.bindings.find((item) => item.projectId === p?.id);
        if (!p || body.conversationId && entry?.projectId !== p.id)
          throw fail3("SCOPE_CHANGED", "The project or conversation changed");
        saved.selection = { projectId: p.id, conversationId: entry?.id || null };
        save();
        emit();
        return snapshot();
      }
      if (name === "connection.connect" || name === "connection.disconnect" || name === "connection.saveCredential") {
        fields3(body, ["projectId", "cameraToken", "executionToken"], ["projectId"]);
        const p = project2(body.projectId);
        if (!p)
          throw fail3("PROJECT_CHANGED", "Select an existing project");
        if (name === "connection.connect")
          return connect(p);
        const link = links.get(p.id);
        if (name === "connection.saveCredential") {
          if (link?.endpoint || pendingProjects.has(p.id))
            throw fail3("CONNECTION_ACTIVE", "Disconnect before replacing Node credentials");
          const credential = { cameraToken: text4(body.cameraToken, "Camera token", 256), executionToken: body.executionToken ? text4(body.executionToken, "Execution token", 256) : "" };
          const reference = p.connection.credentialRef || `operator-${hash([dataDir, p.id]).slice(0, 40)}`;
          await secrets.write(reference, JSON.stringify(credential));
          p.connection.credentialRef = reference;
          save();
          emit();
          return snapshot();
        }
        if (pendingProjects.has(p.id) || link?.physical && unresolved(link.physical.workcell.snapshot()) || saved.ownership.some((record) => record.projectId === p.id))
          throw fail3("OWNERSHIP_UNRESOLVED", "Stop or resolve this project’s owned operation before disconnecting.");
        clearTimeout(link?.timer);
        link?.leave?.();
        await link?.physical?.dispose();
        await link?.close?.();
        link?.offDisconnect?.();
        if (link?.key)
          endpointOwners.delete(link.key);
        if (p.connection.expectedNodeId)
          nodeOwners.delete(p.connection.expectedNodeId);
        links.delete(p.id);
        p.generation += 1;
        save();
        emit();
        return snapshot();
      }
      const owner = scope(body, { generation: name !== "session.agentState" && name !== "experiment.stop" && name !== "experiment.finish" && name !== "workcell.commissioning.stop" });
      if (name === "session.agentState") {
        fields3(body, ["projectId", "conversationId", "serverId", "sessionId", "connectionGeneration", "busy", "error"], ["serverId", "sessionId", "busy"]);
        if (typeof body.busy !== "boolean")
          throw fail3("INVALID_REQUEST", "Agent busy state must be explicit");
        owner.context.busy = body.busy;
        owner.context.error = body.error ? text4(body.error, "Agent error", 500) : null;
        const link = links.get(owner.p.id);
        if (link?.physicalOwner === owner.entry.id) {
          if (body.busy)
            link.physical.workcell.agentStart("");
          else
            link.physical.workcell.agentSettled();
        }
        emit();
        return snapshot();
      }
      if (name.startsWith("experiment.")) {
        const operation = name.slice(11), allowed = {
          propose: ["goal", "trialLimit", "requestId", "mode"],
          approve: ["experimentId", "expectedDigest", "approved"],
          approveAndContinue: ["experimentId", "expectedDigest", "approved", "requestId"],
          continue: ["experimentId", "expectedDigest", "requestId"],
          trial: ["experimentId", "requestId", "offsetMm"],
          finish: ["experimentId"],
          stop: ["experimentId"]
        }[operation];
        if (!allowed)
          throw fail3("UNSUPPORTED_COMMAND", "This experiment action is unsupported");
        fields3(body, ["projectId", "conversationId", "connectionGeneration", "serverId", "sessionId", ...allowed]);
        if (operation === "stop") {
          owner.context.stopEpoch += 1;
          owner.context.continuation?.abort();
        }
        return await withContext(owner.context, operation === "stop", async () => {
          if (operation === "approveAndContinue" || operation === "continue")
            return continueExperiment(owner, body, operation === "approveAndContinue");
          if (operation === "approve") {
            scope(body, { selected: true });
            if (body.approved !== true)
              throw fail3("APPROVAL_REQUIRED", "Explicitly approve this exact synthetic proposal");
          }
          const payload = Object.fromEntries(allowed.filter((key) => key !== "approved" && Object.hasOwn(body, key)).map((key) => [key, body[key]]));
          const result = await owner.context.experiments[operation](payload);
          emit();
          return result;
        });
      }
      if (name.startsWith("workcell.")) {
        const operation = name.slice(9), stop = operation.endsWith(".stop"), frame = operation === "camera.frame";
        if (!["refresh", "setup.inspect", "camera.start", "camera.stop", "camera.frame", "execution.refresh", "execution.prepare", "execution.approve", "execution.stop", "execution.select", "execution.receipt", "execution.reconcile", "commissioning.refresh", "commissioning.inspect", "commissioning.prepare", "commissioning.approve", "commissioning.stop", "commissioning.recoveryInspect", "commissioning.recoveryConfirm"].includes(operation))
          throw fail3("UNSUPPORTED_COMMAND", "This workcell action is unsupported");
        if (stop) {
          owner.context.physicalStopEpoch += 1;
          const recovered = await recoveredStop(owner, operation, body);
          if (recovered)
            return recovered;
        }
        if (!stop)
          scope(body, { physical: true });
        const review = ["camera.start", "execution.prepare", "execution.approve", "commissioning.inspect", "commissioning.prepare", "commissioning.approve", "commissioning.recoveryInspect", "commissioning.recoveryConfirm"].includes(operation);
        if (review)
          scope(body, { selected: true });
        if (operation === "commissioning.recoveryInspect" || operation === "commissioning.recoveryConfirm") {
          const recovered = await recoveredCommissioning(owner, operation, body);
          if (recovered)
            return recovered;
        }
        return await withContext(owner.context, stop || frame, () => withPhysical(owner, stop || frame, async (physical2) => {
          if (review)
            scope(body, { selected: true });
          const { projectId, conversationId, serverId, sessionId, connectionGeneration, ...payload } = body;
          if (operation === "refresh") {
            fields3(payload, []);
            return physical2.workcell.refresh();
          }
          if (operation === "setup.inspect")
            return physical2.inspectSetup(payload);
          if (operation === "camera.frame") {
            fields3(payload, ["frameId"], ["frameId"]);
            return { ...await physical2.workcell.cameraFrame(text4(payload.frameId, "Frame ID", 128)), id: payload.frameId, ...bindingScope(owner.entry), captureSessionId: physical2.workcell.snapshot().camera.stopCaptureSessionId };
          }
          if (["camera.start", "execution.prepare"].includes(operation)) {
            saved.ownership.push({
              projectId: owner.p.id,
              conversationId: owner.entry.id,
              nodeId: owner.p.connection.expectedNodeId,
              connectionGeneration: owner.p.generation,
              kind: operation.startsWith("camera") ? "camera" : "execution",
              captureSessionId: null,
              runId: null,
              status: "REQUEST_PENDING",
              recovered: false
            });
            save();
          }
          if (operation.startsWith("camera."))
            return physical2.workcell.cameraAction(operation.slice(7), payload);
          if (operation.startsWith("commissioning.") && !stop)
            scope(body, { physical: true, selected: review });
          if (operation === "commissioning.approve") {
            journalPhysical(owner.p, owner.entry, links.get(owner.p.id));
            save();
          }
          if (operation.startsWith("commissioning."))
            return physical2.workcell.commissioningAction(operation.slice(14), payload);
          if (operation.startsWith("execution."))
            return physical2.workcell.executionAction(operation.slice(10), payload);
          throw fail3("UNSUPPORTED_COMMAND", "This workcell action is unsupported");
        }));
      }
      throw fail3("UNSUPPORTED_COMMAND", "This operator command is unsupported");
    } catch (error) {
      throw publicError(error);
    }
  }
  async function agentCall(input) {
    try {
      ensureOpen();
      fields3(input, ["agentToken", "name", "arguments", "callId", "signal"], ["agentToken", "name", "arguments", "callId"]);
      const { signal, ...payload } = input;
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw fail3("INVALID_REQUEST", "The trusted cancellation signal is invalid");
      const checkCancelled = () => {
        if (signal?.aborted)
          throw fail3("REQUEST_CANCELLED", "The assistant request was cancelled. Inspect its retained outcome before retrying.");
      };
      checkCancelled();
      const body = clean(payload);
      fields3(body, ["agentToken", "name", "arguments", "callId"], ["agentToken", "name", "arguments", "callId"]);
      const id5 = tokens.get(body.agentToken), entry = binding(id5);
      if (!entry || !agentToolNames.includes(body.name))
        throw fail3("AGENT_FORBIDDEN", "This agent capability or tool is not available");
      const definition = agentToolDefinitions.find((tool) => tool.name === body.name), args = body.arguments;
      fields3(args, Object.keys(definition.parameters.properties || {}), definition.parameters.required || []);
      const callId = text4(body.callId, "Tool call ID", 256), stableId = `agent-${hash([entry.serverId, entry.sessionId, callId])}`;
      const owner = scope(bindingScope(entry)), context = owner.context;
      return await withContext(context, false, async () => {
        checkCancelled();
        let result;
        const tool = context.tools.find((tool2) => tool2.name === body.name);
        if (tool) {
          try {
            result = await tool.execute(callId, { ...args, ...["propose_local_experiment", "run_simulated_trial"].includes(body.name) ? { requestId: stableId } : {} }, signal);
          } catch (error) {
            throw fail3(error.code || "EXPERIMENT_UNAVAILABLE", error.message);
          }
        } else if (body.name === "read_agent_skill") {
          skillTool ||= createReadAgentSkillTool({ registry: loadVerifiedAgentSkills({ ...skillPackageRoot ? { packageRoot: skillPackageRoot } : {} }) });
          result = await skillTool.execute(callId, args);
        } else {
          scope(bindingScope(entry), { physical: true });
          result = await withPhysical(owner, false, async (physical2) => {
            const physicalTool = physical2.tools.find((tool2) => tool2.name === body.name);
            if (physicalTool)
              return physicalTool.execute(callId, args);
            const value = body.name === "inspect_physical_setup" ? await physical2.inspectSetup(args) : await physical2.inspectExecution(args);
            return { content: [{ type: "text", text: JSON.stringify(value) }] };
          });
        }
        checkCancelled();
        const current = context.experiments.snapshot().current;
        return { ...result, details: { ...result.details, physicalSystems: {
          ...bindingScope(entry),
          ...tool && current ? { experimentId: current.id, planDigest: current.planDigest } : {}
        } } };
      });
    } catch (error) {
      throw publicError(error);
    }
  }
  async function close() {
    if (closed)
      return;
    if (closePromise)
      return closePromise;
    if (catalogPending || pendingProjects.size || [...contexts.values()].some((context) => context.mutation || context.continuation || ACTIVE.has(context.experiments.snapshot().current?.phase)) || [...links.values()].some((link) => link.physical && unresolved(link.physical.workcell.snapshot())) || saved.ownership.length)
      throw fail3("OWNERSHIP_UNRESOLVED", "Stop or resolve the retained operations and pending requests before closing the service.");
    closing = true;
    closePromise = (async () => {
      try {
        for (const link of links.values()) {
          clearTimeout(link.timer);
          link.leave?.();
          await link.physical?.dispose();
          link.physical = null;
          link.physicalOwner = null;
          link.leave = null;
          try {
            await link.close?.();
          } catch {
            link.status = "offline";
            link.observedAt = null;
            link.error = "Connection cleanup is unconfirmed. Retain this connection and retry closing after its status is resolved.";
            emit();
            throw fail3("CLEANUP_UNCONFIRMED", link.error);
          }
          link.offDisconnect?.();
          link.status = "offline";
          link.observedAt = null;
          link.transportLost = true;
        }
        for (const context of contexts.values()) {
          context.unsubscribe();
          await context.experiments.dispose();
        }
        for (const retained of recoveryControllers.values())
          retained.controller.dispose();
        closed = true;
        tokens.clear();
        listeners.clear();
        store.release();
      } finally {
        closing = false;
        closePromise = null;
      }
    })();
    return closePromise;
  }
  return Object.freeze({
    snapshot,
    command,
    agentCall,
    close,
    subscribe(listener) {
      ensureOpen();
      if (typeof listener !== "function")
        throw new TypeError("A listener is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
export {
  createPublicClients,
  createOperatorService,
  agentToolNames,
  agentToolDefinitions
};

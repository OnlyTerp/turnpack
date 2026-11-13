/**
 * Worker-thread entry point for pattern work (regex search, glob listing). It exists so the
 * main thread can walk away from a pattern that will not finish; see runPatternJob.
 */
import { parentPort, workerData } from "node:worker_threads";
import { listGlobMatches, searchWithNodeEngine, type PatternJob } from "./workspace.js";

const job = workerData as PatternJob;
parentPort?.postMessage(job.op === "search" ? searchWithNodeEngine(job) : listGlobMatches(job));

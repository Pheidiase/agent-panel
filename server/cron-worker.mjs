import { parentPort, workerData } from "node:worker_threads";
import { readCronView } from "./cron-store.mjs";
parentPort.postMessage(readCronView(workerData));

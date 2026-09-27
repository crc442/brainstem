import { CODING_TASKS, LIVE } from "./protocol";
import { runLiveTask } from "./driver";

const request = JSON.parse(await Bun.stdin.text());
const task = CODING_TASKS.find((t) => t.id === request.taskId);
if (!task || !LIVE.arms.includes(request.arm)) throw new Error("unknown live task/arm");
process.stdout.write(JSON.stringify(await runLiveTask(task, request.arm, request.journalPath)));

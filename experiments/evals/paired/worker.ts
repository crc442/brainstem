import { ARMS, validateProtocol } from "./protocol";
import { FIXTURES } from "./fixtures";
import { runFixture } from "./driver";

// This worker supports scripted fixtures only. No provider or shell-execution path.
const request = JSON.parse(await Bun.stdin.text());
const fixture = FIXTURES.find((f) => f.id === request.taskId);
const arm = ARMS.find((a) => a.id === request.arm);
if (!fixture || !arm) throw new Error("unknown fixture/arm");
const result = await runFixture(fixture, arm, validateProtocol(request.protocol));
process.stdout.write(JSON.stringify(result));

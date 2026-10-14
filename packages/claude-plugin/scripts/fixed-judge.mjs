// Loaded by the daemon through BRAINSTEM_JUDGE_MODULE. Answers every question with its
// lowest value so verify-build runs are deterministic and need no API key.
export async function complete(prompt) {
  const lines = prompt.split("\n");
  const answers = {};
  lines.forEach((line, index) => {
    const question = line.match(/^- "([^"]+)" \((noul|score|choice)/);
    if (!question) return;
    const [, id, type] = question;
    answers[id] = type === "choice" ? lines[index + 1].match(/"([^"]+)"=/)[1] : 0;
  });
  return JSON.stringify(answers);
}

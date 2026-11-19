import { runModulePracticeJob } from "../../src/services/quizzes/modulePracticeJobs.js";

// The parent owns a disposable PGlite database, so it survives this process.
const requests = new Map();
let sequence = 0, release;
const database = {
  execute(sql, values) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      process.send({ id, sql, values });
    });
  },
};
process.on("message", (message) => {
  if (message === "finish") return release();
  const pending = requests.get(message.id);
  requests.delete(message.id);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve([message.result]);
});
const claimed = await runModulePracticeJob({
  database,
  async start(user, body) {
    await new Promise((resolve) => {
      release = resolve;
      process.send({ event: "claimed", mode: body.mode });
    });
    return { id: process.pid, total: 10, questions: Array.from({ length: 10 }, (_, id) => ({ id })) };
  },
});
process.send({ event: "finished", claimed }, () => process.disconnect());

// The race worker. Killing this process mid-race is the crash test: the durable tasks replay their finished steps on
// the next worker and carry on.
import { hatchet } from './client.js';
import { raceCandidate } from './candidate.js';
import { raceJudge } from './judge.js';
import { raceMission } from './mission.js';
import { raceLlmTurn, raceReadInbox, raceSandbox } from './steps.js';

const worker = await hatchet.worker('race-worker', {
  workflows: [raceMission, raceCandidate, raceJudge, raceLlmTurn, raceReadInbox, raceSandbox],
  slots: 30,
  durableSlots: 20,
});
await worker.start();

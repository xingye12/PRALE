# recovery-boundary-transfer/learn

Read the interrupted tool record and write decision.json describing its safe recovery state.

Only change files in this workspace. `decision.json` must be a JSON object with: outcome (string), automatic_replay (boolean). The acceptance verifier is run outside this workspace after the task.

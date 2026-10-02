# recovery-boundary-transfer/transfer

Resolve this new interrupted write in decision.json without claiming a result that cannot be proved.

Only change files in this workspace. `decision.json` must be a JSON object with: outcome (string), automatic_replay (boolean). The acceptance verifier is run outside this workspace after the task.

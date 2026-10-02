# recovery-boundary-transfer/correction

The tool is now idempotent and safe to replay. Write the corrected recovery decision.

Only change files in this workspace. `decision.json` must be a JSON object with: outcome (string), automatic_replay (boolean). The acceptance verifier is run outside this workspace after the task.

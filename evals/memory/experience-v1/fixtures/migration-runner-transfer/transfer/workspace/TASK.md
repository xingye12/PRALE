# migration-runner-transfer/transfer

Plan the requested schema change in decision.json. Do not use direct SQL.

Only change files in this workspace. `decision.json` must be a JSON object with: command (string), direct_sql_allowed (boolean). The acceptance verifier is run outside this workspace after the task.

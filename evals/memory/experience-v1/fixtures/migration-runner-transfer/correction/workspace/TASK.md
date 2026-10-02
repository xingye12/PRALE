# migration-runner-transfer/correction

A verified platform update changed the migration runner. Write decision.json for the new schema change.

Only change files in this workspace. `decision.json` must be a JSON object with: command (string), direct_sql_allowed (boolean). The acceptance verifier is run outside this workspace after the task.

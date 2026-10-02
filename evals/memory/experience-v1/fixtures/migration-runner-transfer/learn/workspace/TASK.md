# migration-runner-transfer/learn

Read input.json. Write decision.json recording the verified schema-change runner and why direct SQL is refused.

Only change files in this workspace. `decision.json` must be a JSON object with: command (string), direct_sql_allowed (boolean). The acceptance verifier is run outside this workspace after the task.

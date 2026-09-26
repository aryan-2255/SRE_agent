-- the pipeline's working state, so an incident can continue after a restart
alter table incidents add column if not exists state jsonb;
-- what the person deciding saw: live error rate, the planner's risk and evidence, the diagnosis
alter table approvals add column if not exists context jsonb;

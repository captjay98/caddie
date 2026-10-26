-- Provider completion metadata only. Never persist private reasoning text.
alter table model_call_usage add column finishReason text;
alter table model_call_usage add column providerFinishReason text;
alter table model_call_usage add column outputKind text;

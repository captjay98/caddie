/** Only explicit new-project requests: ordinary feature edits stay in scope. */
export function requestsDifferentProject(text: string): boolean {
 return /^(?:please\s+)?(?:i (?:want|need)(?: you)? to\s+)?(?:start|create|build|make)\s+(?:(?:a|an)\s+)?(?:new|different|another)\s+(?:project|app)\b/i.test(text.trim());
}

export function refersToExistingWork(text: string): boolean {
 return !requestsDifferentProject(text) && /\b(?:this|that|the|existing)\s+(?:plan|app|project)\b/i.test(text) && /\b(?:continue|carry on|update|revise|change|fix|put|add|resume)\b/i.test(text);
}

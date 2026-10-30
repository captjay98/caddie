import { SPECIALIST_INSTRUCTIONS, BUILD_RECIPE_INSTRUCTION } from '../apps/app/src/agents/specialists.ts';
import { LOOKS_BLOCK_GUIDE, ACCEPTANCE_JOURNEY_GUIDE, PROTOTYPE_GUIDE, reviewChecklist, LOOKS_REVIEW_CRITERIA, DESIGN_REVIEW_CRITERIA, DESIGN_REVIEW_NOT_JUDGED, DESIGN_CHECK_ADVICE } from '@caddie/contracts';
const now = SPECIALIST_INSTRUCTIONS.designer.length;
const oldGuide = 5200; // approx old LOOKS_BLOCK_GUIDE length measured below via git stash? (not available)
console.log(JSON.stringify({ designerInstructionNow: now, buildRecipe: BUILD_RECIPE_INSTRUCTION.length, looksGuide: LOOKS_BLOCK_GUIDE.length, acceptanceGuide: ACCEPTANCE_JOURNEY_GUIDE.length, prototypeGuide: PROTOTYPE_GUIDE.length, reviewCriteria: reviewChecklist(LOOKS_REVIEW_CRITERIA).length + reviewChecklist(DESIGN_REVIEW_CRITERIA).length + DESIGN_REVIEW_NOT_JUDGED.length + DESIGN_CHECK_ADVICE.length }));

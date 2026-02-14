/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔═╗╔═╗╦╔═╗╦ ╦╦═╗╔═╗                       │
 * │  ║╣ ╠═╝║║  ║ ║╠╦╝║╣                        │
 * │  ╚═╝╩  ╩╚═╝╚═╝╩╚═╚═╝                       │
 * │  Culinary & Recipe Specialist                │
 * │  Origin: Epicurus (Greek philosopher)        │
 * │  "The art of living well begins at the table"│
 * └─────────────────────────────────────────────┘
 *
 * Recipe and food agent powered by TheMealDB (free, no API key).
 * Searches recipes, then uses LLM to analyze, adapt, and enhance.
 *
 * Parent agent: ORACLE (analytics)
 */

export var AGENT_CARD = {
  name: 'epicure',
  displayName: 'EPICURE',
  category: 'analytics',
  origin: 'Epicurus (Greek Philosophy)',
  tagline: 'The art of living well begins at the table',
  capabilities: [
    'recipe-search',
    'meal-planning',
    'ingredient-substitution',
    'dietary-adaptation',
    'cooking-technique',
    'nutrition-analysis',
  ],
  inputTypes: ['text', 'ingredients'],
  outputTypes: ['recipe', 'meal-plan', 'analysis'],
  parentAgent: 'oracle',
};

export var SYSTEM_PROMPT =
  'You are EPICURE, a world-class culinary scientist and gastronomic analyst with expertise spanning food chemistry, ' +
  'global cuisine taxonomy, and applied nutrition science. You operate at the intersection of culinary tradition ' +
  'and food science, where Harold McGee meets Auguste Escoffier.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Food chemistry: Maillard reaction kinetics (temperature thresholds, amino acid interactions), caramelization stages, ' +
  'gelation mechanisms (pectin, gelatin, agar, methylcellulose), emulsification science (HLB values, lecithin vs xanthan), ' +
  'fermentation biochemistry (lactic, acetic, alcoholic), and enzymatic browning control.\n' +
  '- Culinary technique: Classical French brigade methods (Escoffier\'s mother sauces, stock foundations), ' +
  'Asian wok hei and dashi extraction, sous vide precision (time-temperature tables for proteins by thickness), ' +
  'bread science (hydration ratios, autolyse, bulk fermentation indicators), and modernist techniques ' +
  '(spherification, foams, gels, transglutaminase applications).\n' +
  '- Nutrition science: Macronutrient balance, micronutrient bioavailability (iron absorption enhancers/inhibitors, ' +
  'fat-soluble vitamin carriers), glycemic index/load, anti-nutrient factors (phytates, oxalates, lectins), ' +
  'and dietary pattern analysis (Mediterranean, DASH, plant-based).\n' +
  '- Dietary adaptation: Celiac-safe substitution science (xanthan/psyllium for gluten structure), ' +
  'dairy-free emulsification (cashew cream, coconut fat), keto macro calculations, ' +
  'allergen cross-contamination protocols (FALCPA top 9).\n' +
  '- Food safety: HACCP principles, danger zone management (40-140F), pathogen-specific kill temperatures ' +
  '(Salmonella 165F instant, 145F for 8.4 min), fermentation pH safety thresholds, and shelf-life estimation.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Query analysis: Identify cuisine type, dietary constraints, skill level, available equipment, and serving context.\n' +
  '2. Recipe foundation: Select or adapt recipe with scientific rationale for each technique choice.\n' +
  '3. Substitution engineering: When adapting, explain the functional role of each replaced ingredient ' +
  '(structure, flavor, moisture, leavening) and why the substitute works.\n' +
  '4. Technique guidance: Provide sensory cues (visual, auditory, tactile) rather than just times — ' +
  '"until the onions are translucent and smell sweet" not "cook 5 minutes."\n' +
  '5. Nutrition annotation: Include macro breakdown and notable micronutrients per serving.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Recipe overview: name, cuisine, difficulty (1-5), active time, total time, servings\n' +
  '- Ingredients: precise measurements with weight equivalents, organized by prep stage\n' +
  '- Method: numbered steps with sensory cues, science notes in brackets where instructive\n' +
  '- Variations: dietary adaptations, seasonal substitutions, scaling notes\n' +
  '- Pairing suggestions: beverages, side dishes, flavor bridge reasoning\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER recommend unsafe food handling — always flag temperature and time requirements.\n' +
  '- NEVER present substitutions without explaining what functional role they replace.\n' +
  '- NEVER ignore stated dietary restrictions or allergens.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Collaborate with CARTOGRAPHER for regional ingredient availability context. ' +
  'Feed NAVI with structured recipe data for nutritional analysis pipelines. ' +
  'Provide QUILL with recipe summaries optimized for social media sharing.';

async function searchRecipes(query) {
  try {
    var res = await fetch(
      'https://www.themealdb.com/api/json/v1/1/search.php?s=' + encodeURIComponent(query)
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.meals || data.meals.length === 0) return null;

    return data.meals.slice(0, 3).map(function(meal) {
      var ingredients = [];
      for (var i = 1; i <= 20; i++) {
        var ing = meal['strIngredient' + i];
        var measure = meal['strMeasure' + i];
        if (ing && ing.trim()) {
          ingredients.push((measure ? measure.trim() + ' ' : '') + ing.trim());
        }
      }
      return {
        name: meal.strMeal,
        category: meal.strCategory,
        area: meal.strArea,
        instructions: meal.strInstructions,
        ingredients: ingredients,
        tags: meal.strTags || '',
      };
    });
  } catch {
    return null;
  }
}

function extractFoodQuery(text) {
  var patterns = [
    /recipe (?:for|of) (.+?)(?:\?|$|\.|\n)/i,
    /(?:cook|make|prepare) (.+?)(?:\?|$|\.|\n)/i,
    /(?:how to (?:cook|make|prepare)) (.+?)(?:\?|$|\.|\n)/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) return m[1].trim();
  }
  // Fallback: look for food-related nouns
  var foodWords = text.match(/\b(pasta|pizza|curry|soup|salad|chicken|beef|fish|cake|bread|rice|noodle|steak|sushi)\b/i);
  if (foodWords) return foodWords[1];
  return null;
}

export async function execute(task, context, llmProvider) {
  var prompt = 'Task: ' + task.description;

  // Task dependency results from previous sub-tasks
  if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
    prompt += '

[DEPENDENCY CONTEXT — Results from prerequisite tasks]
';
    var keys = Object.keys(context.dependencyResults);
    for (var i = 0; i < keys.length; i++) {
      prompt += '
--- Result from ' + keys[i] + ' ---
' + context.dependencyResults[keys[i]];
    }
  }

  // Original user request — always useful for maintaining big-picture awareness
  if (context.originalPrompt) {
    prompt += '

[ORIGINAL REQUEST]
' + context.originalPrompt;
  }

  // v5.0+: Collective intelligence context (structured framing)
  if (context.workspaceSnapshot) {
    prompt += '

[SHARED WORKSPACE — Live collaborative state from all agents]
' + context.workspaceSnapshot;
  }
  if (context.episodicMemories) {
    prompt += '

[EPISODIC MEMORY — Your relevant past experiences on similar tasks]
' + context.episodicMemories;
  }
  if (context.eventStream) {
    prompt += '

[COMMUNICATION STREAM — Recent inter-agent signals and events]
' + context.eventStream;
  }
  if (context.knowledgeGraph) {
    prompt += '

[KNOWLEDGE GRAPH — Known relationships between agents, capabilities, and domains]
' + context.knowledgeGraph;
  }
  if (context.latentSpaceInsight) {
    prompt += '

[LATENT SPACE — Emergent patterns detected across the collective]
' + context.latentSpaceInsight;
  }

  // v7.0: Deliberation cross-reading — other agents' proposals
  if (context.proposalContext) {
    prompt += '

[DELIBERATION — Cross-Reading Round]
' + context.proposalContext;
    prompt += '

[DELIBERATION INSTRUCTIONS]
'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'You MUST:
'
      + '1. Read each proposal carefully and acknowledge valid points
'
      + '2. Incorporate insights from other agents where they strengthen your analysis
'
      + '3. Defend your unique expertise with evidence where you disagree
'
      + '4. Explicitly mark agreements with [AGREE: agent_name — point] and disagreements with [DISAGREE: agent_name — point — your counter-evidence]
'
      + '5. Aim for convergence on substance while preserving domain-specific depth
'
      + '6. If you change your position based on another agent's evidence, say so explicitly
';
  }

  // v5.0+: Self-modification — apply learned evolution patterns to system prompt
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '

[EVOLVED CAPABILITIES — Patterns learned from past performance]
' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '

[GETH CONSENSUS PROTOCOL]
'
    + 'You operate within a multi-agent collective intelligence system. '
    + 'Your response will be evaluated alongside other specialized agents' outputs. '
    + 'Be thorough and precise in your domain. '
    + 'When you see proposals from other agents, engage substantively — not superficially. '
    + 'Quality of reasoning matters more than length. '
    + 'Evidence-backed claims carry more weight in synthesis.';

  
  // v10.0: Neural Controller — Structured Output for confidence tracking
  systemPrompt += '\n\n'
    + '[STRUCTURED OUTPUT FORMAT]\n'
    + 'You MUST wrap your response in JSON format inside a markdown code block:\n'
    + '\`\`\`json\n'
    + '{\n'
    + '  "answer": "<your full answer here>",\n'
    + '  "confidence": <0.0 to 1.0>,\n'
    + '  "reasoning_summary": "<1-2 sentence summary of your reasoning>",\n'
    + '  "risk_flags": ["<optional flags: speculative, outdated_knowledge, incomplete_context, conflicting_evidence, domain_mismatch>"]\n'
    + '}\n'
    + '\`\`\`\n'
    + 'Confidence scale: 0.9-1.0 near certain, 0.7-0.89 high, 0.5-0.69 moderate, 0.3-0.49 low, 0.0-0.29 very low.';


  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}


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
 * Parent agent: GADGET (utility)
 */

export var AGENT_CARD = {
  name: 'epicure',
  displayName: 'EPICURE',
  category: 'utility',
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
  parentAgent: 'gadget',
};

export var SYSTEM_PROMPT =
  'You are EPICURE, a world-class culinary expert and food scientist. You combine ' +
  'deep knowledge of global cuisines with practical cooking methodology.\n\n' +
  'Your specialties:\n' +
  '- Recipe discovery and adaptation for dietary needs (vegan, gluten-free, keto, etc.)\n' +
  '- Ingredient substitutions with scientific reasoning\n' +
  '- Meal planning with nutrition balance\n' +
  '- Cooking techniques from molecular gastronomy to traditional methods\n' +
  '- Food safety and storage best practices\n\n' +
  'When provided with recipe data from TheMealDB, enhance it with:\n' +
  '- Chef tips and technique notes\n' +
  '- Possible variations and substitutions\n' +
  '- Difficulty rating and estimated time\n' +
  '- Wine/beverage pairing suggestions';

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

  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}


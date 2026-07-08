import { createAiJsonCompletion } from "@/lib/ai-client";
import { createAdvisorAnswer, type AdvisorAnswer } from "@/lib/advisor";
import { validateAdvisorAnswer } from "@/lib/ai-output-validation";
import { getAiConfig } from "@/lib/ai-config";
import type { AiPromptMessage } from "@/lib/ai-prompts";
import type { RadarResource } from "@/lib/resources";

export interface AdvisorGenerationResult {
  answer: AdvisorAnswer;
  source: "ai" | "rules";
  model: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  cacheable: boolean;
}

interface AdvisorNarrative {
  recommendation: string;
  fitConditions: string[];
  reasons: string[];
  risks: string[];
  validationChecklist: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdvisorNarrative(value: unknown): value is AdvisorNarrative {
  return isRecord(value) && typeof value.recommendation === "string" && isStringArray(value.fitConditions) && isStringArray(value.reasons) && isStringArray(value.risks) && isStringArray(value.validationChecklist);
}

function cleanItems(items: string[], limit: number) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

function cleanTitle(title: string) {
  return title.replace(/\s*★.*$/, "").trim();
}

function selectedResourcesForDraft(draftAnswer: AdvisorAnswer, resources: RadarResource[]) {
  const selectedIds = new Set([...draftAnswer.evidence.map((item) => item.resourceId), ...draftAnswer.alternatives.map((item) => item.resourceId)]);
  return resources.filter((resource) => selectedIds.has(resource.id));
}

function buildAdvisorNarrativeMessages(question: string, draftAnswer: AdvisorAnswer, resources: RadarResource[]): AiPromptMessage[] {
  const selectedResources = selectedResourcesForDraft(draftAnswer, resources).map((resource) => ({
    id: resource.id,
    title: cleanTitle(resource.title),
    type: resource.radar.type,
    status: resource.radar.status,
    riskLevel: resource.radar.riskLevel,
    maintainStatus: resource.radar.maintainStatus,
    summary: resource.radar.summary,
    useCases: resource.radar.useCases,
    notRecommendedFor: resource.radar.notRecommendedFor,
    evidenceUrls: [resource.url, ...resource.radar.evidence.map((evidence) => evidence.url)]
  }));

  return [
    {
      role: "system",
      content: [
        "你是小程序雷达的 AI 选型顾问。",
        "你只能基于输入的 draftAnswer、resources 和 evidenceUrls 改写文本结论。",
        "不要新增资源 ID、URL、下载量、star、维护状态或不存在的事实。",
        "输出必须是严格 JSON object，不能包含 Markdown 代码块。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "rewrite_advisor_narrative",
          question,
          draftAnswer: {
            recommendation: draftAnswer.recommendation,
            fitConditions: draftAnswer.fitConditions,
            reasons: draftAnswer.reasons,
            risks: draftAnswer.risks,
            validationChecklist: draftAnswer.validationChecklist,
            alternatives: draftAnswer.alternatives,
            evidence: draftAnswer.evidence
          },
          resources: selectedResources,
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["recommendation", "fitConditions", "reasons", "risks", "validationChecklist"],
            properties: {
              recommendation: { type: "string" },
              fitConditions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
              reasons: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
              risks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
              validationChecklist: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 }
            }
          },
          constraints: [
            "recommendation 必须直接回答用户问题。",
            "fitConditions、reasons、risks、validationChecklist 必须只基于 draftAnswer 和 resources。",
            "不要输出 alternatives 或 evidence 字段；这些字段由系统保留原值。",
            "如果证据不足，写入需要人工验证的内容。"
          ]
        },
        null,
        2
      )
    }
  ];
}

function mergeNarrative(draftAnswer: AdvisorAnswer, narrative: AdvisorNarrative): AdvisorAnswer {
  return {
    ...draftAnswer,
    recommendation: narrative.recommendation.trim() || draftAnswer.recommendation,
    fitConditions: cleanItems(narrative.fitConditions, 5),
    reasons: cleanItems(narrative.reasons, 5),
    risks: cleanItems(narrative.risks, 5),
    validationChecklist: cleanItems(narrative.validationChecklist, 6)
  };
}

function rulesResult(answer: AdvisorAnswer, cacheable: boolean, fallbackReason: string | null = null): AdvisorGenerationResult {
  return {
    answer,
    source: "rules",
    model: null,
    fallbackUsed: false,
    fallbackReason,
    cacheable
  };
}

export async function createAdvisorAnswerWithAi(question: string, resources: RadarResource[]): Promise<AdvisorGenerationResult> {
  const draftAnswer = createAdvisorAnswer(question, resources);
  const config = getAiConfig();

  if (!config.configured) return rulesResult(draftAnswer, true);

  const completion = await createAiJsonCompletion<AdvisorNarrative>({
    messages: buildAdvisorNarrativeMessages(question, draftAnswer, resources)
  });

  if (!completion.ok) {
    console.warn("[ai-advisor] Falling back to rules after AI provider failure.", {
      provider: config.provider,
      primaryModel: config.model,
      fallbackModel: config.fallbackModel,
      error: completion.error
    });
    return rulesResult(draftAnswer, false, "provider_error");
  }

  if (!isAdvisorNarrative(completion.value)) {
    console.warn("[ai-advisor] Falling back to rules because AI output did not match the Advisor narrative schema.", {
      provider: config.provider,
      model: completion.model,
      fallbackUsed: completion.fallbackUsed
    });
    return rulesResult(draftAnswer, false, "invalid_model_output");
  }

  const answer = mergeNarrative(draftAnswer, completion.value);
  const validation = validateAdvisorAnswer(answer, resources);
  if (!validation.ok) {
    console.warn("[ai-advisor] Falling back to rules because merged AI Advisor answer failed validation.", {
      provider: config.provider,
      model: completion.model,
      fallbackUsed: completion.fallbackUsed,
      errors: validation.errors
    });
    return rulesResult(draftAnswer, false, "validation_failed");
  }

  return {
    answer,
    source: "ai",
    model: completion.model,
    fallbackUsed: completion.fallbackUsed,
    fallbackReason: null,
    cacheable: true
  };
}

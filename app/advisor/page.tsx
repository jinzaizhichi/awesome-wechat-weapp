import { AdvisorForm } from "./advisor-form";

export const metadata = {
  title: "Advisor | 小程序雷达"
};

export default function AdvisorPage() {
  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <p className="text-sm font-semibold text-primary">Advisor</p>
        <h1 className="mt-2 text-3xl font-black leading-tight sm:text-4xl">AI 选型顾问</h1>
        <p className="mt-3 text-base leading-7 text-muted-foreground">
          基于本地资源库、评分字段和 evidence URL 生成选型建议。配置模型后会调用 OpenAI-compatible API，输出校验失败时自动回退规则结果。
        </p>
      </section>
      <AdvisorForm />
    </div>
  );
}

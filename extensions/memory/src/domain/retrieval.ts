export type RetrievalRoute = "memory" | "knowledge" | "mixed" | "none";

export function routeQuery(query: string): RetrievalRoute {
  const text = query.toLocaleLowerCase();
  const memory = /(?:last time|previously|before|prefer|decided|decision|continue|之前|上次|以前|偏好|决定|继续|为什么)/u.test(text);
  const knowledge = /(?:current|code|function|document|docs|config|symbol|implementation|当前|代码|函数|文档|配置|实现)/u.test(text);
  if (memory && knowledge) return "mixed";
  if (memory) return "memory";
  if (knowledge) return "knowledge";
  if (!text.trim() || /^(?:hi|hello|thanks|谢谢|你好)[!.！。]?$/iu.test(text.trim())) return "none";
  return "memory";
}

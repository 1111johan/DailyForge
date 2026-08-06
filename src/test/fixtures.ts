export function validGeneratedPost() {
  return {
    topic: "四级只剩30天怎么安排",
    content_type: "学习计划",
    target_user: "基础一般且备考时间有限的大学生",
    title_candidates: [
      "四级只剩30天，真的别再乱刷题了",
      "基础一般，四级30天这样安排",
      "四级复习顺序，我终于整理清楚了",
    ],
    selected_title: "基础一般，四级30天这样安排",
    body: "每天先完成一组有明确目标的训练，再根据错题定位薄弱环节。".repeat(25),
    hashtags: ["#大学英语四级", "#四级备考", "#学习计划", "#大学生学习", "#英语学习"],
    cover: { title: "四级30天怎么复习？", subtitle: "按周推进，不再乱刷题" },
    image_briefs: [
      { index: 1, type: "cover", title: "四级30天怎么复习？", subtitle: "按周推进", key_points: [] },
      { index: 2, type: "content", title: "第一周先找薄弱项", key_points: ["完成诊断", "整理错题"] },
      { index: 3, type: "content", title: "第二三周做专项", key_points: ["听力精听", "阅读复盘"] },
      { index: 4, type: "content", title: "最后一周做整套", key_points: ["限时训练", "保持节奏"] },
    ],
  } as const;
}

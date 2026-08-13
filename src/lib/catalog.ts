import type { ContentTopic, Product, ProductLevel, ProductMode } from "@/lib/types/domain";

const CATALOG_TIMESTAMP = "2026-08-01T00:00:00.000Z";

const PRODUCT_DESCRIPTION =
  "大学英语四级、六级电子复习资料，包含听力、阅读、写作、翻译四大专项，涵盖题型方法、高频考点、专项训练、参考答案、解析说明、错题复盘及30天复习计划。商品为电子版虚拟资料，包含PDF及部分可编辑文件，无实物、无需快递。";

const SELLING_POINTS = [
  "四级和六级内容分开整理",
  "听力、阅读、写作、翻译四大专项",
  "方法讲解、高频考点和专项训练",
  "参考答案、解析说明和错题复盘",
  "可执行的30天复习计划",
  "PDF及部分可编辑文件",
];

const PROHIBITED_CLAIMS = [
  "包过",
  "保过",
  "保证425",
  "官方内部",
  "泄题",
  "原题押中",
  "百分百提分",
];

function product(level: ProductLevel, name: string): Product {
  return {
    id: level,
    name,
    level,
    description: PRODUCT_DESCRIPTION,
    selling_points: SELLING_POINTS,
    prohibited_claims: PROHIBITED_CLAIMS,
    product_assets: [],
    is_active: true,
    created_at: CATALOG_TIMESTAMP,
    updated_at: CATALOG_TIMESTAMP,
  };
}

export const PRODUCTS: Product[] = [
  product("cet4", "大学英语四级专项资料包"),
  product("cet6", "大学英语六级专项资料包"),
];

type TopicSeed = Pick<
  ContentTopic,
  "id" | "topic" | "content_type" | "module" | "target_user" | "priority"
>;

function topics(level: ProductLevel, seeds: TopicSeed[]): ContentTopic[] {
  return seeds.map((seed) => ({
    ...seed,
    id: `${level}-${seed.id}`,
    product_id: level,
    planned_date: null,
    used_at: null,
    is_active: true,
    created_at: CATALOG_TIMESTAMP,
    updated_at: CATALOG_TIMESTAMP,
  }));
}

export const CONTENT_TOPICS: ContentTopic[] = [
  ...topics("cet4", [
    { id: "freshman-start", topic: "准大一现在开始准备四级，第一步应该做什么", content_type: "入门指南", module: "全科", target_user: "准备入学、希望提前规划四级的准大一新生", priority: 120 },
    { id: "first-month", topic: "大一开学第一个月如何把四级复习安排进课表", content_type: "学习计划", module: "全科", target_user: "刚进入大学、课程安排尚未稳定的大一学生", priority: 115 },
    { id: "thirty-days", topic: "四级只剩30天，如何安排每天的复习顺序", content_type: "冲刺计划", module: "全科", target_user: "备考时间有限、需要快速抓重点的四级考生", priority: 110 },
    { id: "listening-news", topic: "四级新闻听力总是跟不上，应该怎样拆开练", content_type: "专项方法", module: "听力", target_user: "四级新闻听力失分较多的大学生", priority: 105 },
    { id: "reading-location", topic: "四级阅读定位慢，如何练同义替换和原文定位", content_type: "专项方法", module: "阅读", target_user: "阅读做题速度慢、正确率不稳定的四级考生", priority: 104 },
    { id: "writing-combine", topic: "四级作文不背万能模板，如何组合自己的句型", content_type: "学习方法", module: "写作", target_user: "作文表达单一、不知道如何展开观点的四级考生", priority: 103 },
    { id: "translation-rephrase", topic: "四级翻译遇到不会的词，怎样换一种表达", content_type: "专项方法", module: "翻译", target_user: "翻译词汇不足、容易卡在单句的四级考生", priority: 102 },
    { id: "diagnosis", topic: "第一次做四级真题，怎样诊断自己的薄弱项", content_type: "薄弱项诊断", module: "全科", target_user: "尚未系统做过四级真题的大一学生", priority: 101 },
    { id: "mistake-review", topic: "四级错题不是抄答案，应该怎样做复盘", content_type: "复盘方法", module: "全科", target_user: "做题不少但正确率没有明显变化的四级考生", priority: 100 },
    { id: "materials-order", topic: "四级资料很多却学不完，正确使用顺序是什么", content_type: "经验分享", module: "全科", target_user: "收集了很多资料但缺少执行顺序的四级考生", priority: 99 },
  ]),
  ...topics("cet6", [
    { id: "after-cet4", topic: "四级通过后准备六级，学习方法要改哪些地方", content_type: "入门指南", module: "全科", target_user: "刚通过四级、准备开始六级的大学生", priority: 120 },
    { id: "semester-plan", topic: "大学生一学期准备六级，如何安排四个专项", content_type: "学习计划", module: "全科", target_user: "希望用一学期系统准备六级的大学生", priority: 115 },
    { id: "thirty-days", topic: "六级考前30天，如何从专项训练过渡到整套模拟", content_type: "冲刺计划", module: "全科", target_user: "进入六级考前冲刺阶段的大学生", priority: 110 },
    { id: "lecture-listening", topic: "六级讲座听力信息太密，怎样抓结构和重点", content_type: "专项方法", module: "听力", target_user: "六级讲座与报道题失分较多的考生", priority: 105 },
    { id: "long-sentences", topic: "六级阅读长难句看不懂，如何分层拆解", content_type: "专项方法", module: "阅读", target_user: "六级阅读受长难句影响较大的考生", priority: 104 },
    { id: "writing-depth", topic: "六级作文怎样把观点写得更有层次", content_type: "学习方法", module: "写作", target_user: "六级作文内容空泛、论证不足的考生", priority: 103 },
    { id: "translation-topics", topic: "六级翻译如何按文化科技教育主题积累表达", content_type: "专项方法", module: "翻译", target_user: "六级翻译缺少主题词汇储备的考生", priority: 102 },
    { id: "score-diagnosis", topic: "六级正确率不稳定，如何找出真正的失分原因", content_type: "薄弱项诊断", module: "全科", target_user: "做过多套六级真题但成绩波动较大的考生", priority: 101 },
    { id: "review-system", topic: "六级错题如何按题型建立可回看的复盘系统", content_type: "复盘方法", module: "全科", target_user: "需要系统整理六级错题的大学生", priority: 100 },
    { id: "materials-order", topic: "六级资料应该先学方法还是先做真题", content_type: "经验分享", module: "全科", target_user: "不确定六级资料使用顺序的大学生", priority: 99 },
  ]),
];

export function activeProducts(input: { productId?: string; productMode: ProductMode }) {
  return PRODUCTS.filter((item) => {
    if (input.productId) return item.id === input.productId;
    return input.productMode === "rotate" || item.level === input.productMode;
  });
}

export function productById(id: string) {
  return PRODUCTS.find((item) => item.id === id) || null;
}

export function topicById(id: string) {
  return CONTENT_TOPICS.find((item) => item.id === id) || null;
}

export function topicsForProduct(productId: string) {
  return CONTENT_TOPICS.filter(
    (item) => item.product_id === productId && item.is_active,
  );
}

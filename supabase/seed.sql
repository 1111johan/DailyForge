-- Replace this sample with the product's verified facts, then set is_active = true.
insert into public.products (
  name,
  level,
  description,
  selling_points,
  prohibited_claims,
  product_assets,
  is_active
)
values (
  '示例：大学英语四级专项资料包',
  'cet4',
  '这是占位数据，接入真实生成前必须替换。',
  '["听力专项", "阅读专项", "写作专项", "翻译专项", "答案解析", "错题复盘"]'::jsonb,
  '["包过", "保过", "保证425", "官方内部", "泄题", "原题押中", "百分百提分"]'::jsonb,
  '[]'::jsonb,
  false
)
on conflict (name, level) do nothing;

insert into public.content_topics (
  product_id,
  topic,
  content_type,
  module,
  target_user,
  priority,
  is_active
)
select
  id,
  '四级只剩30天怎么安排',
  '学习计划',
  '全科',
  '基础一般、每天可学习60至90分钟的大学生',
  100,
  false
from public.products
where name = '示例：大学英语四级专项资料包' and level = 'cet4'
on conflict (product_id, topic) do nothing;

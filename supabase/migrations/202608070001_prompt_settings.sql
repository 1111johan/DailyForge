create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb
    check (jsonb_typeof(value) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

alter table public.app_settings enable row level security;

insert into public.app_settings (key, value)
values (
  'xiaohongshu_generation_prompts',
  jsonb_build_object(
    'copyPrompt', $copy$
围绕大学英语四六级备考写一篇可直接发布的小红书笔记。

选题方向：
- 四级内容优先面向准大一新生和大一学生，帮助他们从入学起尽早准备四级，解决不知道从哪里开始、学习顺序混乱、容易拖延的问题。
- 六级内容面向已经通过四级或正在准备六级的大学生，重点讲清六级与四级的差异、分项提升方法、复习节奏和错题复盘。

写作要求：
1. 标题具体、有真实痛点，不夸张承诺，不使用培训机构口吻。
2. 正文像学长学姐的经验分享，先指出问题，再给可执行步骤，并自然说明资料如何配合学习。
3. 正文控制在500至900个中文字符，绝不能超过1000字符。
4. 四级和六级内容严格区分，避免空泛鸡汤、硬广和资料堆砌感。
5. 结尾给出适合人群和下一步行动，并附相关小红书话题标签。
$copy$,
    'imagePrompt', $image$
为同一篇小红书笔记制作四张统一风格的2:3竖版图片，面向大学生英语四六级备考。

画面方向：真实、清爽、有学习氛围的大学校园工作台；使用白色和浅灰底、深墨色正文、红色重点标记与少量绿色进度元素。可以出现活页纸、课表、耳机、真题、荧光笔和学习清单等真实物件，不使用渐变、光晕、3D文字或夸张营销海报效果。

四张图的分工：
1. 封面：突出本篇核心问题与四级或六级身份，一眼能看懂主题。
2. 内容页：展示当前备考误区或薄弱项诊断。
3. 内容页：展示分步骤学习方法、专项安排或时间计划。
4. 内容页：展示复盘清单、执行计划或资料使用顺序。

图片中的中文必须简短、清晰、准确；四级内容优先体现准大一和大一新生场景，六级内容体现大学生进阶备考场景。四张图视觉统一但版式不重复。
$image$
  )
)
on conflict (key) do nothing;

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
  product.id,
  topic.topic,
  topic.content_type,
  topic.module,
  topic.target_user,
  topic.priority,
  true
from public.products as product
cross join (
  values
    ('cet4', '准大一新生暑假怎么开始准备四级', '学习计划', '全科', '即将进入大学、想提前准备四级的新生', 220),
    ('cet4', '大一开学后四级备考第一周做什么', '入门指南', '全科', '刚入学、不知道四级从哪里开始的大一学生', 215),
    ('cet4', '大一新生四级听力从零开始怎么练', '专项方法', '听力', '听力基础薄弱的准大一和大一学生', 210),
    ('cet4', '大一课多时间碎，四级每天怎么安排', '学习计划', '全科', '课程较多、每天只有碎片时间的大一学生', 205),
    ('cet6', '四级刚过，大学生怎么衔接六级复习', '入门指南', '全科', '刚通过四级、准备继续考六级的大学生', 220),
    ('cet6', '大学生准备六级，最先补哪一项', '薄弱项诊断', '全科', '准备六级但不清楚自身薄弱项的大学生', 215),
    ('cet6', '六级阅读和四级到底差在哪里', '专项方法', '阅读', '四级阅读尚可、六级正确率不稳定的大学生', 210),
    ('cet6', '大学课程忙，六级30天怎么安排', '学习计划', '全科', '备考时间有限、需要明确复习顺序的大学生', 205)
) as topic(level, topic, content_type, module, target_user, priority)
where product.level = topic.level and product.is_active = true
on conflict (product_id, topic) do update set
  content_type = excluded.content_type,
  module = excluded.module,
  target_user = excluded.target_user,
  priority = excluded.priority,
  is_active = true;

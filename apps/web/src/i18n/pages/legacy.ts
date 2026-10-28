/**
 * 旧 V4 流水线下线时的提示（生产缺省不装配脚本 / 分镜 / 旧配音等测试替身，见 ANCS_LEGACY_PIPELINE）。
 * 中文为基准，英文覆盖同一结构——类型检查保证不缺键。
 */

const zhCN = {
  title: '这里不再用旧版脚本 / 分镜流程制作',
  body: '这个部署没有开启旧版的 AI 写稿、分镜、配音与素材搜索；已有作品仍可查看、出片和发布。新的视频请到共看片室，和 AI 剪辑师一起做——放素材，或贴一篇文章都可以。',
  openStudio: '在共看片室打开这个作品',
  newInStudio: '去共看片室新建',
};

const en: typeof zhCN = {
  title: 'The old script / storyboard flow is retired here',
  body: 'This deployment does not run the old AI script writing, storyboard, narration and stock search. Existing projects can still be viewed, rendered and published. Make new videos in the studio with your AI editor — drop in footage or paste an article.',
  openStudio: 'Open this project in the studio',
  newInStudio: 'Start in the studio',
};

export const LEGACY_TEXT = { 'zh-CN': zhCN, en };

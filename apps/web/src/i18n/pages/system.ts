/**
 * 系统页（找不到页面、页面出错）的文案。中文为基准，英文覆盖同一结构——类型检查保证不缺键。
 * 只说能确定的事：已保存的改动在服务端，不会因为这个页面出错而丢失。
 */

const zhCN = {
  notFound: {
    title: '这个页面不存在',
    body: '链接可能已经过期，或者作品已被移走、删除。',
    home: '回到创作台',
  },
  error: {
    title: '这个页面出了点问题',
    body: '页面没能正常显示。已经保存的改动都在，不会因此丢失；可以重试一次。',
    retry: '重试',
    home: '回到创作台',
    reference: (digest: string) => `错误编号：${digest}（联系支持时请附上）`,
  },
};

const en: typeof zhCN = {
  notFound: {
    title: 'This page does not exist',
    body: 'The link may have expired, or the project was moved or deleted.',
    home: 'Back to home',
  },
  error: {
    title: 'Something went wrong on this page',
    body: 'The page could not be shown. Your saved changes are safe and nothing is lost; you can try again.',
    retry: 'Try again',
    home: 'Back to home',
    reference: (digest: string) => `Error reference: ${digest} (include it when you contact support)`,
  },
};

export const SYSTEM_TEXT = { 'zh-CN': zhCN, en };

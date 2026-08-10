// 自定义 helper：从渲染后的 HTML 中提取纯文本摘要
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*>`_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

hexo.extend.helper.register('auto_excerpt', function (content, len) {
  len = len || 120;
  const text = stripHtml(content);
  return text.length > len ? text.slice(0, len) + '…' : text;
});

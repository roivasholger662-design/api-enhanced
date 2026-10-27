// 每日风格推荐场景配置设置

const createOption = require('../util/option.js')

const isValidId = (value) =>
  (typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0

const invalidParameter = (msg) =>
  Promise.reject({
    status: 400,
    body: { code: 400, msg },
    cookie: [],
  })

module.exports = (query, request) => {
  // 保留 category 的优先级，同时兼容旧文档中的 categoryId。
  const category =
    query.category !== undefined ? query.category : query.categoryId
  if (!isValidId(category)) {
    return invalidParameter('category（或 categoryId）必须为非负安全整数')
  }

  const tags = Array.isArray(query.tags)
    ? Array.from(query.tags)
    : typeof query.tags === 'string'
      ? query.tags.split(',')
      : [query.tags]
  if (tags.length === 0 || !tags.every(isValidId)) {
    return invalidParameter('tags 必须包含有效的风格标签 ID（非负安全整数）')
  }

  const data = {
    tags: JSON.stringify({
      tagIds: tags.map(Number),
      categoryId: Number(category),
    }),
  }
  return request(
    `/api/homepage/daily/song/tag/save`,
    data,
    createOption(query, 'xeapi'),
  )
}

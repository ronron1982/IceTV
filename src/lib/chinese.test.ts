import {
  getSearchQueryVariants,
  toSimplified,
  toTraditional,
} from './chinese';

describe('Chinese conversion helpers', () => {
  it('converts between Simplified and Traditional Chinese', () => {
    expect(toTraditional('搜索电影')).toBe('搜尋電影');
    expect(toSimplified('搜尋電影')).toBe('搜索电影');
  });

  it('returns both query forms without duplicates', () => {
    expect(getSearchQueryVariants('搜尋電影')).toEqual(['搜尋電影', '搜索电影']);
  });
});

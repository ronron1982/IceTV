import {
  getBackFallbackPath,
  normalizeInternalReturnPath,
  withReturnTo,
} from '@/lib/navigation-return';

describe('navigation return', () => {
  it('保留站内路径的查询参数和锚点', () => {
    expect(normalizeInternalReturnPath('/search?q=凡人#results')).toBe(
      '/search?q=%E5%87%A1%E4%BA%BA#results',
    );
  });

  it.each([
    'https://example.com/path',
    '//example.com/path',
    '/\\example.com/path',
    '/play?title=test',
  ])('拒绝非法或循环返回路径 %s', (value) => {
    expect(normalizeInternalReturnPath(value, '/categories')).toBe(
      '/categories',
    );
  });

  it('为点播地址写入来源页面', () => {
    const target = withReturnTo('/play?source=test&id=1', '/douban?type=tv');
    const parsed = new URL(target, 'https://icetv.local');

    expect(parsed.pathname).toBe('/play');
    expect(parsed.searchParams.get('returnTo')).toBe('/douban?type=tv');
  });

  it('搜索返回地址中的繁体查询会统一转换为简体', () => {
    const target = withReturnTo(
      '/play?title=%E7%8B%97%E7%8B%97%E7%9A%84%E5%AE%8C%E7%BE%8E%E5%9C%A3%E8%AF%9E',
      '/search?q=%E7%8B%97%E7%8B%97%E7%9A%84%E5%AE%8C%E7%BE%8E%E8%81%96%E8%AA%95',
    );
    const parsed = new URL(target, 'https://icetv.local');

    expect(parsed.searchParams.get('returnTo')).toBe(
      '/search?q=%E7%8B%97%E7%8B%97%E7%9A%84%E5%AE%8C%E7%BE%8E%E5%9C%A3%E8%AF%9E',
    );
  });

  it('为直播地址写入完整来源页面', () => {
    const target = withReturnTo(
      '/live',
      '/search?q=%E6%96%B0%E9%97%BB#results',
    );
    const parsed = new URL(target, 'https://icetv.local');

    expect(parsed.pathname).toBe('/live');
    expect(parsed.searchParams.get('returnTo')).toBe(
      '/search?q=%E6%96%B0%E9%97%BB#results',
    );
  });

  it('为主要返回页面提供稳定回退', () => {
    expect(getBackFallbackPath('/play')).toBe('/');
    expect(getBackFallbackPath('/douban')).toBe('/');
    expect(getBackFallbackPath('/live')).toBe('/');
    expect(getBackFallbackPath('/me/favorites')).toBe('/me');
    expect(getBackFallbackPath('/settings')).toBe('/me');
    expect(getBackFallbackPath('/u/abc')).toBe('/me');
  });
});

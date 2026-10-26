/**
 * dsh-attachment-panel — 客户端半边
 *
 * 入口就是官方「主区域面板」：侧栏「新建会话」下面多一行「投送记录」（和「插件」「自动化任务」并列），
 * 点它主区域整块换成 /dsh-ap/ 的 iframe。两个注册的 id/key 必须一致：
 *   - ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label })  → 侧栏那一行
 *   - ctx.slots.register({ name: 'main',              key: PANEL_ID })        → 点开后的内容
 * 不一致的话 layout.selectPanel 会抛 “main panel … is not registered”。
 *
 * 面板本体（索引、缩略图、文件操作）全在宿主半边 lib/index.js，这里只有壳。
 * 全程 fail-open：注册失败只是入口不见，不碰官方 UI。
 */
window.__ModuleLoader__.load({
  id: 'dsh-attachment-panel',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var PKG = 'dsh-attachment-panel';
    var PANEL_ID = 'attachment-panel';
    var PANEL_URL = '/dsh-ap/';

    function log(level, msg) {
      try {
        var fn = console[level] || console.log;
        fn('[' + PKG + '] ' + msg);
      } catch (error) {
        /* 忽略 */
      }
    }

    /** 图片 + 回形针图标；panellist 会把 size 传进来。 */
    function PanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16;
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('rect', { x: 1.8, y: 2.8, width: 12.4, height: 10.4, rx: 2.4 }),
        React.createElement('path', { d: 'M2.2 10.4 5.6 7.4l2.5 2.2 2.1-2 3.6 3.2' }),
        React.createElement('circle', { cx: 10.4, cy: 6, r: 1.05 }),
      );
    }

    /** 主区域面板：整块交给 /dsh-ap/，逻辑全在宿主半边。 */
    function PanelView() {
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            minWidth: 0,
            background: 'var(--dsw-alias-bg-base, #fff)',
          },
        },
        React.createElement('iframe', {
          src: PANEL_URL,
          title: '投送记录',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            minHeight: 0,
            border: 0,
            display: 'block',
            background: 'var(--dsw-alias-bg-base, #fff)',
          },
        }),
      );
    }

    function guarded(Component) {
      return function Guarded(props) {
        try {
          return React.createElement(Component, props);
        } catch (error) {
          log('warn', '渲染失败：' + String(error));
          return null;
        }
      };
    }

    function apply(ctx) {
      // 主区域内容
      try {
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: function () {
                return {};
              },
            },
            guarded(PanelView),
          );
        });
        log('info', '主区域面板已注册：' + PANEL_ID);
      } catch (error) {
        log('warn', '主区域面板注册失败：' + String(error));
      }

      // 侧栏那一行（新建会话下面）
      try {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: function () {
                return '投送记录';
              },
            },
            guarded(PanelIcon),
          );
        });
        log('info', '侧栏面板入口已注册：' + PANEL_ID);
      } catch (error) {
        log('warn', '侧栏面板入口注册失败：' + String(error));
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.__internals = { PANEL_ID: PANEL_ID, PANEL_URL: PANEL_URL };
    return module.exports;
  },
});

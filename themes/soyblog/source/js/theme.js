(function () {
  'use strict';
  var root = document.documentElement;

  /* ---------- 暗色模式 ---------- */
  var themeToggle = document.getElementById('theme-toggle');
  var hljsDark = document.getElementById('hljs-dark');
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    if (hljsDark) hljsDark.disabled = (t !== 'dark');
    if (themeToggle) themeToggle.textContent = (t === 'dark') ? '☀️' : '🌙';
  }
  var saved = localStorage.getItem('theme');
  var initial = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(initial);
  if (themeToggle) themeToggle.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  });

  /* ---------- 阅读进度条 + 回到顶部 ---------- */
  var progress = document.getElementById('reading-progress');
  var backTop = document.getElementById('back-to-top');
  function onScroll() {
    if (progress) {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      var pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
      progress.style.width = pct + '%';
    }
    if (backTop) backTop.hidden = window.scrollY < 400;
  }
  if (backTop) backTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 移动端导航 ---------- */
  var navToggle = document.getElementById('nav-toggle');
  var siteNav = document.getElementById('site-nav');
  if (navToggle && siteNav) navToggle.addEventListener('click', function () { siteNav.classList.toggle('open'); });

  /* ---------- 代码复制按钮 ---------- */
  document.querySelectorAll('.post-content pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', function () {
      var code = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText;
      navigator.clipboard.writeText(code).then(function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  /* ---------- 文章目录 TOC + 滚动高亮 ---------- */
  var content = document.querySelector('.post-content');
  var tocNav = document.getElementById('toc-list');
  var tocAside = document.querySelector('.post-toc');
  if (content && tocNav) {
    var heads = content.querySelectorAll('h2, h3');
    if (heads.length < 2) {
      if (tocAside) tocAside.style.display = 'none';
    } else {
      var ol = document.createElement('ol');
      ol.className = 'toc';
      heads.forEach(function (h, i) {
        if (!h.id) h.id = 'toc-' + i + '-' + (h.textContent || '').slice(0, 24).trim().replace(/\s+/g, '-');
        var li = document.createElement('li');
        li.className = 'toc-' + h.tagName.toLowerCase();
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.replaceState(null, '', '#' + h.id);
        });
        li.appendChild(a);
        ol.appendChild(li);
      });
      tocNav.appendChild(ol);
      var links = Array.prototype.slice.call(ol.querySelectorAll('a'));
      if ('IntersectionObserver' in window) {
        var obs = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              links.forEach(function (l) { l.classList.remove('active'); });
              var act = links.filter(function (l) { return l.getAttribute('href') === '#' + en.target.id; })[0];
              if (act) act.classList.add('active');
            }
          });
        }, { rootMargin: '-80px 0px -70% 0px' });
        heads.forEach(function (h) { obs.observe(h); });
      }
    }
  }
  var tocToggle = document.getElementById('toc-toggle');
  if (tocToggle && tocAside) tocToggle.addEventListener('click', function () { tocAside.classList.toggle('open'); });

  /* ---------- 社交分享 ---------- */
  document.querySelectorAll('.share-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-share');
      var url = encodeURIComponent(location.href);
      var title = encodeURIComponent(document.title);
      if (type === 'weibo') {
        window.open('https://service.weibo.com/share/share.php?url=' + url + '&title=' + title, '_blank');
      } else if (type === 'qq') {
        window.open('https://connect.qq.com/widget/shareqq/index.html?url=' + url + '&title=' + title, '_blank');
      } else if (type === 'xhs') {
        window.open('https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent('豆奶与程序猫'), '_blank');
      } else if (type === 'copy') {
        navigator.clipboard.writeText(location.href).then(function () {
          var t = btn.textContent;
          btn.textContent = '已复制链接';
          setTimeout(function () { btn.textContent = t; }, 1500);
        });
      }
    });
  });

  /* ---------- 搜索 ---------- */
  var searchToggle = document.getElementById('search-toggle');
  var searchModal = document.getElementById('search-modal');
  var searchInput = document.getElementById('search-input');
  var searchResults = document.getElementById('search-results');
  var index = null;
  function loadIndex(cb) {
    if (index) { cb(index); return; }
    fetch('/search.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { index = Array.isArray(d) ? d : (d.posts || []); cb(index); })
      .catch(function () { index = []; cb(index); });
  }
  function strip(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function doSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { searchResults.innerHTML = ''; return; }
    loadIndex(function (posts) {
      var hits = [];
      posts.forEach(function (p) {
        var text = strip(p.content || '').toLowerCase();
        var title = (p.title || '').toLowerCase();
        var tags = (p.tags || []).join(' ').toLowerCase();
        var idx = title.indexOf(q);
        var score = idx >= 0 ? 0 : (text.indexOf(q) >= 0 ? 1 : (tags.indexOf(q) >= 0 ? 2 : -1));
        if (score >= 0) {
          var plain = strip(p.content || '');
          var pos = plain.toLowerCase().indexOf(q);
          var snip = pos >= 0 ? plain.slice(Math.max(0, pos - 40), pos + 80) : plain.slice(0, 80);
          hits.push({ title: p.title, url: p.url, snip: snip, score: score });
        }
      });
      hits.sort(function (a, b) { return a.score - b.score; });
      hits = hits.slice(0, 12);
      if (!hits.length) { searchResults.innerHTML = '<p class="search-empty">没有找到相关文章</p>'; return; }
      searchResults.innerHTML = hits.map(function (h) {
        return '<a class="search-item" href="' + h.url + '"><span class="search-item__title">' + h.title + '</span><span class="search-item__snip">…' + h.snip + '…</span></a>';
      }).join('');
      Array.prototype.slice.call(searchResults.querySelectorAll('.search-item')).forEach(function (a) {
        a.addEventListener('click', function () { closeSearch(); });
      });
    });
  }
  function openSearch() { if (!searchModal) return; searchModal.hidden = false; if (searchInput) searchInput.focus(); }
  function closeSearch() {
    if (!searchModal) return;
    searchModal.hidden = true;
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = '';
  }
  if (searchToggle) searchToggle.addEventListener('click', openSearch);
  if (searchModal) searchModal.addEventListener('click', function (e) { if (e.target === searchModal) closeSearch(); });
  if (searchInput) searchInput.addEventListener('input', function () { doSearch(this.value); });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== searchInput) { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape') { closeSearch(); if (siteNav) siteNav.classList.remove('open'); }
  });
})();

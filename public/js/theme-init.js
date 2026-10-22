// 首屏前应用主题与密度，避免闪烁（同步执行，体积尽量小）
(function () {
  try {
    var t = JSON.parse(localStorage.getItem("cfm:theme") || '"auto"');
    var d = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = d ? "dark" : "light";
    document.documentElement.dataset.density = JSON.parse(localStorage.getItem("cfm:density") || '"comfortable"');
    var l = JSON.parse(localStorage.getItem("cfm:lang") || '"auto"');
    if (l === "auto") l = (navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    document.documentElement.lang = l === "en" ? "en" : "zh-CN";
  } catch (e) {}
})();

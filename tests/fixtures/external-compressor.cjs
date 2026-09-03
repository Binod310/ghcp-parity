module.exports = {
  name: "fixture_shrink",
  compress: (text) => text.replace(/fixture/g, "f"),
};

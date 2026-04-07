exports.default = async function skipDependencyInstall() {
  // Returning false tells electron-builder to skip dependency install/rebuild.
  return false;
};

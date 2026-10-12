import browserPath from "path-browserify";

const posix = browserPath;
const win32 = {
  ...browserPath,
  delimiter: ";",
  sep: "\\",
};

export const basename = browserPath.basename;
export const delimiter = browserPath.delimiter;
export const dirname = browserPath.dirname;
export const extname = browserPath.extname;
export const format = browserPath.format;
export const isAbsolute = browserPath.isAbsolute;
export const join = browserPath.join;
export const normalize = browserPath.normalize;
export const parse = browserPath.parse;
export const relative = browserPath.relative;
export const resolve = browserPath.resolve;
export const sep = browserPath.sep;
export { posix, win32 };

export default { ...browserPath, posix, win32 };

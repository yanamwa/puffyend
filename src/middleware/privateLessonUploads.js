import path from 'node:path';

export default function privateLessonUploads(req, res, next) {
  let uploadPath;
  try {
    const decoded = decodeURIComponent(req.path).replace(/\\/g, '/');
    // Windows treats trailing spaces/dots and NTFS stream suffixes specially.
    const canonical = decoded.split('/').map(part => {
      if (part === '.' || part === '..') return part;
      return part.split(':')[0].replace(/[ .]+$/g, '');
    }).join('/');
    uploadPath = path.posix.normalize(canonical).toLowerCase();
  } catch { return res.sendStatus(400); }
  if (uploadPath === '/lessons' || uploadPath.startsWith('/lessons/')) return res.sendStatus(404);
  next();
}

import { uploadToS3 } from './aws.js';
import { uploadToCloudinary } from './cloudinary.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

export const uploadSingle = async (file, provider) => {
  const filePath = file.path;
  const mimetype = file.mimetype;
  try {
    if (provider === 's3') {
      // Keeping s3 behavior the same, returning just URL for backwards compatibility.
      const url = await uploadToS3(filePath, file.filename, mimetype);
      return { secure_url: url, public_id: null };
    }
    // Cloudinary returns { secure_url, public_id }.
    return await uploadToCloudinary(filePath, mimetype);
  } finally {
    // Multer writes to disk before provider upload. Always remove that temporary
    // file, including when the remote provider rejects or times out.
    cleanupFile(filePath);
  }
};

export const uploadMany = async (files, provider) => {
  const results = [];
  for (const file of files) {
    const res = await uploadSingle(file, provider);
    results.push(res);
  }
  return results;
};

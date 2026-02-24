import { uploadToS3 } from './aws.js';
import { uploadToCloudinary } from './cloudinary.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

export const uploadSingle = async (file, provider) => {
  const filePath = file.path;
  const mimetype = file.mimetype;
  let result;

  if (provider === 's3') {
    // Keeping s3 behavior the same, returning just URL for backwards compat if S3 is ever used
    const url = await uploadToS3(filePath, file.filename, mimetype);
    result = { secure_url: url, public_id: null };
  } else {
    // Cloudinary now returns { secure_url, public_id }
    result = await uploadToCloudinary(filePath, mimetype);
  }

  cleanupFile(filePath);
  return result; // returning object now instead of string
};

export const uploadMany = async (files, provider) => {
  const results = [];
  for (const file of files) {
    const res = await uploadSingle(file, provider);
    results.push(res);
  }
  return results;
};
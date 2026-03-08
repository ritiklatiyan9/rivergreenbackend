import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const uploadToS3 = async (filePath, fileName, contentType) => {
  const fileContent = fs.readFileSync(filePath);
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const params = {
    Bucket: bucket,
    Key: fileName,
    Body: fileContent,
    ContentType: contentType,
  };
  const command = new PutObjectCommand(params);
  await s3Client.send(command);
  return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
};
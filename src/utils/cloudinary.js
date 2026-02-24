import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadToCloudinary = async (filePath, mimetype) => {
  try {
    // Determine the correct resource type. Cloudinary treats PDFs as images by default
    // if resource_type isn't 'raw' or 'auto', but 'auto' can sometimes mistakenly place PDFs in /image/upload
    // which causes them to not open properly via the raw URL or causes cors/x-frame issues.
    // For PDFs to be downloaded/viewed naturally, 'raw' is often preferred.
    const isPDF = mimetype === 'application/pdf';

    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'uploads',
      resource_type: isPDF ? 'raw' : 'auto',
      // For PDFs, we want to deliver them properly
      // format: isPDF ? 'pdf' : undefined,
    });

    return {
      secure_url: result.secure_url,
      public_id: result.public_id,
    };
  } catch (error) {
    console.error('Cloudinary Upload Error:', error);
    throw new Error('Failed to upload file to Cloudinary');
  }
};
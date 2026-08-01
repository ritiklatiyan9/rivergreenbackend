import asyncHandler from '../utils/asyncHandler.js';
import salesAssistant, { AssistantInputError } from '../services/salesAssistant.service.js';

export const chatWithSalesAssistant = asyncHandler(async (req, res) => {
  try {
    const result = await salesAssistant.answer({ user: req.user, body: req.body });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof AssistantInputError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    throw error;
  }
});

export default chatWithSalesAssistant;

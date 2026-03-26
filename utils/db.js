import { ObjectId } from "mongodb";

/**
 * Safely converts a string to a MongoDB ObjectId.
 * Returns null if the id is invalid, preventing server crashes.
 * @param {string} id
 * @returns {ObjectId|null}
 */
const toObjectId = (id) => {
  try {
    if (!id || !ObjectId.isValid(id)) return null;
    return new ObjectId(id);
  } catch {
    return null;
  }
};

export default toObjectId;

import MasterModel from './MasterModel.js';

class ChatPermissionModel extends MasterModel {
  constructor() {
    super('chat_permissions');
  }

  /**
   * Get permissions for a specific role
   */
  async getByRole(roleName, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE role_name = $1`;
    const result = await pool.query(query, [roleName]);
    return result.rows[0];
  }

  /**
   * Get all permissions
   */
  async getAllPermissions(pool) {
    const query = `SELECT * FROM ${this.tableName} ORDER BY role_name`;
    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Update permission for a role
   */
  async updatePermission(roleName, data, pool) {
    const { can_edit_message, can_delete_message } = data;
    const query = `
      UPDATE ${this.tableName}
      SET can_edit_message = COALESCE($1, can_edit_message),
          can_delete_message = COALESCE($2, can_delete_message)
      WHERE role_name = $3
      RETURNING *
    `;
    const result = await pool.query(query, [can_edit_message, can_delete_message, roleName]);
    return result.rows[0];
  }
}

export default new ChatPermissionModel();

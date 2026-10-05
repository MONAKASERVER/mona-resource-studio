import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/pool.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { requireProjectPermission } from "../policy.js";
import type { RealtimeHub } from "../services/realtime.js";

const paramsSchema = z.object({ projectId: z.string().uuid() });
const itemParamsSchema = z.object({ projectId: z.string().uuid(), itemId: z.string().uuid() });
const categoryParamsSchema = z.object({ projectId: z.string().uuid(), categoryId: z.string().uuid() });
const categorySchema = z.object({ name: z.string().trim().min(1).max(80), parentId: z.string().uuid().nullable().default(null) });
const itemSchema = z.object({
  logicalId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(160),
  displayName: z.string().trim().min(1).max(160),
  baseItemId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(160),
  categoryId: z.string().uuid().nullable().default(null),
  textureRef: z.string().max(512).nullable().default(null),
  modelRef: z.string().max(512).nullable().default(null),
});

export async function itemRoutes(app: FastifyInstance, db: Database, realtime: RealtimeHub): Promise<void> {
  app.get("/projects/:projectId/categories", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    return (await db.query("SELECT id, parent_id AS \"parentId\", name, sort_order AS \"sortOrder\" FROM categories WHERE project_id = $1 ORDER BY sort_order, name", [projectId])).rows;
  });

  app.post("/projects/:projectId/categories", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const body = categorySchema.parse(request.body);
    if (body.parentId) { const parent = await db.query("SELECT 1 FROM categories WHERE id = $1 AND project_id = $2", [body.parentId, projectId]); if (!parent.rowCount) throw new AppError(400, "CATEGORY_PARENT_INVALID", "親カテゴリが同じプロジェクトにありません。"); }
    const result = await db.query("INSERT INTO categories (project_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id, parent_id AS \"parentId\", name, sort_order AS \"sortOrder\"", [projectId, body.parentId, body.name]);
    await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, ip, user_agent) VALUES ($1, $2, 'category.created', 'category', $3, $4, $5)", [projectId, user.sub, result.rows[0].id, request.ip, request.headers["user-agent"] ?? null]);
    reply.code(201); return result.rows[0];
  });

  app.delete("/projects/:projectId/categories/:categoryId", async (request, reply) => {
    const user = await requireUser(request); const { projectId, categoryId } = categoryParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write");
    const result = await db.query("DELETE FROM categories WHERE id = $1 AND project_id = $2 RETURNING id", [categoryId, projectId]); if (!result.rowCount) throw new AppError(404, "CATEGORY_NOT_FOUND", "カテゴリが見つかりません。");
    await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, ip, user_agent) VALUES ($1, $2, 'category.deleted', 'category', $3, $4, $5)", [projectId, user.sub, categoryId, request.ip, request.headers["user-agent"] ?? null]); reply.code(204).send();
  });

  app.get("/projects/:projectId/items", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    return (await db.query(`SELECT li.id, li.logical_id AS "logicalId", li.display_name AS "displayName", li.base_item_id AS "baseItemId", li.category_id AS "categoryId", c.name AS "categoryName", li.texture_ref AS "textureRef", li.model_ref AS "modelRef", li.updated_at AS "updatedAt" FROM logical_items li LEFT JOIN categories c ON c.id = li.category_id WHERE li.project_id = $1 ORDER BY li.display_name`, [projectId])).rows;
  });

  app.post("/projects/:projectId/items", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const body = itemSchema.parse(request.body);
    if (body.categoryId) { const category = await db.query("SELECT 1 FROM categories WHERE id = $1 AND project_id = $2", [body.categoryId, projectId]); if (!category.rowCount) throw new AppError(400, "ITEM_CATEGORY_INVALID", "カテゴリが同じプロジェクトにありません。"); }
    try {
      const result = await db.query(`INSERT INTO logical_items (project_id, category_id, logical_id, display_name, base_item_id, texture_ref, model_ref) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, logical_id AS "logicalId", display_name AS "displayName", base_item_id AS "baseItemId", category_id AS "categoryId", texture_ref AS "textureRef", model_ref AS "modelRef", updated_at AS "updatedAt"`, [projectId, body.categoryId, body.logicalId, body.displayName, body.baseItemId, body.textureRef, body.modelRef]);
      await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'item.created', 'logical_item', $3, $4, $5, $6)", [projectId, user.sub, result.rows[0].id, JSON.stringify({ logicalId: body.logicalId }), request.ip, request.headers["user-agent"] ?? null]);
      await realtime.publish(projectId, "item.changed", { itemId: result.rows[0].id, action: "created" }); reply.code(201); return result.rows[0];
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new AppError(409, "ITEM_ID_CONFLICT", "同じLogical IDが既に存在します。"); throw error; }
  });

  app.patch("/projects/:projectId/items/:itemId", async (request) => {
    const user = await requireUser(request); const { projectId, itemId } = itemParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const body = itemSchema.parse(request.body);
    if (body.categoryId) { const category = await db.query("SELECT 1 FROM categories WHERE id = $1 AND project_id = $2", [body.categoryId, projectId]); if (!category.rowCount) throw new AppError(400, "ITEM_CATEGORY_INVALID", "カテゴリが同じプロジェクトにありません。"); }
    try {
      const result = await db.query(`UPDATE logical_items SET category_id = $3, logical_id = $4, display_name = $5, base_item_id = $6, texture_ref = $7, model_ref = $8, updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING id, logical_id AS "logicalId", display_name AS "displayName", base_item_id AS "baseItemId", category_id AS "categoryId", texture_ref AS "textureRef", model_ref AS "modelRef", updated_at AS "updatedAt"`, [itemId, projectId, body.categoryId, body.logicalId, body.displayName, body.baseItemId, body.textureRef, body.modelRef]);
      if (!result.rowCount) throw new AppError(404, "ITEM_NOT_FOUND", "Logical Itemが見つかりません。"); await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'item.updated', 'logical_item', $3, $4, $5, $6)", [projectId, user.sub, itemId, JSON.stringify({ logicalId: body.logicalId }), request.ip, request.headers["user-agent"] ?? null]); await realtime.publish(projectId, "item.changed", { itemId, action: "updated" }); return result.rows[0];
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new AppError(409, "ITEM_ID_CONFLICT", "同じLogical IDが既に存在します。"); throw error; }
  });

  app.delete("/projects/:projectId/items/:itemId", async (request, reply) => {
    const user = await requireUser(request); const { projectId, itemId } = itemParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const result = await db.query("DELETE FROM logical_items WHERE id = $1 AND project_id = $2 RETURNING logical_id", [itemId, projectId]); if (!result.rowCount) throw new AppError(404, "ITEM_NOT_FOUND", "Logical Itemが見つかりません。"); await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'item.deleted', 'logical_item', $3, $4, $5, $6)", [projectId, user.sub, itemId, JSON.stringify({ logicalId: result.rows[0].logical_id }), request.ip, request.headers["user-agent"] ?? null]); await realtime.publish(projectId, "item.changed", { itemId, action: "deleted" }); reply.code(204).send();
  });
}

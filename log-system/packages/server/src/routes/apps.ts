import { Router, Request, Response } from 'express';
import { prisma } from '../db/db.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const apps = await prisma.app.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json(apps);
});

export default router;

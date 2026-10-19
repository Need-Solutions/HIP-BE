import type { RequestHandler } from "express";
import * as profile from "../services/profile.service";

export const getProfile: RequestHandler = async (req, res) => {
  res.json(await profile.getProfile(res.locals.user.id));
};

export const updateProfile: RequestHandler = async (req, res) => {
  res.json(await profile.updateProfile(res.locals.user.id, req.body));
};

export const confirmContact: RequestHandler = async (req, res) => {
  res.json(
    await profile.confirmContact(
      res.locals.user.id,
      req.body.verificationId,
      req.body.code,
    ),
  );
};

export const resendContactCode: RequestHandler = async (req, res) => {
  res.json(
    await profile.resendContactCode(
      res.locals.user.id,
      req.body.verificationId,
    ),
  );
};

export const cancelContactChange: RequestHandler = async (req, res) => {
  res.json(
    await profile.cancelContactChange(
      res.locals.user.id,
      req.params.verificationId,
    ),
  );
};

export const getNotifications: RequestHandler = async (req, res) => {
  res.json(await profile.getNotifications(res.locals.user.id));
};

export const updateNotifications: RequestHandler = async (req, res) => {
  res.json(await profile.updateNotifications(res.locals.user.id, req.body));
};

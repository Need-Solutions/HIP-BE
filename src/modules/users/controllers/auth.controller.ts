import type { RequestHandler } from "express";
import * as auth from "../services/auth.service";
import {
  AUTH_COOKIE,
  cookieOptions,
  revokeSessions,
} from "../services/auth-session.service";

export const signup: RequestHandler = async (req, res) => {
  res.status(201).json(await auth.signup(req.body));
};

export const verify: RequestHandler = async (req, res) => {
  const result = await auth.verify(req.body.verificationId, req.body.code);
  res.cookie(AUTH_COOKIE, result.session.token, result.session.options);
  res.json(result.data);
};

export const resend: RequestHandler = async (req, res) => {
  res.json(await auth.resend(req.body.verificationId, req.body.channel));
};

export const login: RequestHandler = async (req, res) => {
  const result = await auth.login(
    req.body.identifier,
    req.body.password,
    req.body.remember,
  );
  res.cookie(AUTH_COOKIE, result.session.token, result.session.options);
  res.json(result.data);
};

export const logout: RequestHandler = async (req, res) => {
  await revokeSessions(res.locals.user?.id);
  res.clearCookie(AUTH_COOKIE, cookieOptions);
  res.status(204).end();
};

export const forgot: RequestHandler = async (req, res) => {
  await auth.forgot(req.body.email);
  res.status(204).end();
};

export const reset: RequestHandler = async (req, res) => {
  await auth.reset(req.body.token, req.body.password);
  res.clearCookie(AUTH_COOKIE, cookieOptions);
  res.status(204).end();
};

export const me: RequestHandler = (req, res) => {
  res.json(res.locals.user);
};

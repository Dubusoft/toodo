import type { Messages } from "@/locales/en";

export const alerts: Partial<Messages["alerts"]> = {
  statuses: {
    planned: "계획됨",
    in_progress: "진행 중",
    in_review: "완료 대기",
    done: "끝남",
    completed: "완료",
    not_adopted: "채택 안 함",
  },
  started: "태스크 시작",
  awaitingCompletion: "태스크 완료 대기",
  concluded: "태스크가 머지 없이 마무리됨",
  done: "태스크 끝남",
  paused: "태스크 일시 중지",
  changed: "태스크 상태 변경",
};

export function studentCourseContent(course) {
  const modules = course.contentModules || [];
  if (!modules.some(m => m.studentPublished !== undefined)) return course;
  const visible = modules.map(m => m.studentPublished === true);
  const clean = modules.map((module,index) => visible[index] ? module : {
    ...module, description: "Not uploaded yet", summary: "Not uploaded yet",
    learningObjectives: "", learning_objectives: "", lessonPages: [], lesson_pages: [],
    quizItems: [], quiz_items: [], mainQuizSettings: {enabled:false},
  });
  const allowed = item => {
    const id = item.moduleId ?? item.module_id;
    const index = id != null ? modules.findIndex(m => String(m.id ?? m.module_id) === String(id)) : Number(item.moduleIndex ?? item.module_index);
    return Number.isInteger(index) && index >= 0 && visible[index] === true;
  };
  const pages=(course.lessonPages || []).filter(allowed), quizzes=(course.quizItems || []).filter(allowed);
  const lessons=(course.learningModules || []).filter(m=>modules.some((module,index)=>visible[index] && String(module.lesson_id ?? module.id)===String(m.lesson_id ?? m.id)));
  return {...course,contentModules:clean,content_modules:clean,
    lessonPages:pages,lessonContent:JSON.stringify(pages),lesson_content:JSON.stringify(pages),
    quizItems:quizzes,quizModule:JSON.stringify(quizzes),quiz_contents:JSON.stringify(quizzes),
    learningModules:lessons,learning_modules:lessons};
}
